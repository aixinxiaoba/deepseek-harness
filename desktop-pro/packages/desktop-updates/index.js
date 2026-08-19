/**
 * ctx.desktopUpdates (design §4 + ADR-5): the update capability as a Cordis
 * service inside the Host tree, so any surface — tray, web UI, a future TUI —
 * can drive checks without Electron-shell private state. The PRE-BOOT apply
 * half stays in the shell (nothing can run in a tree that has not mounted).
 *
 * Trust anchor: the embedded Ed25519 public key only (fail-closed; the dev
 * fallback requires DSH_PRO_DEV_KEYS=1). Sequence monotonicity, rollout
 * bucketing, per-package sha256, and bounded-concurrency downloads as in
 * updater.cjs, which remains the pre-boot twin of this logic.
 */
import { Service } from '@deepseek-ai/cordis'
import { app, dialog } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
const DOWNLOAD_CONCURRENCY = 4

/** Physical app root: this package lives at <root>/node_modules/desktop-updates. */
const HERE = path.dirname(fs.realpathSync(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const APP_ROOT = path.dirname(path.dirname(HERE))

/** The embedded trust anchor; dev-tree fallback only behind an explicit opt-in. */
function publicKey() {
  try {
    const embedded = require_(path.join(APP_ROOT, 'embedded-key.cjs')).PUBLIC_KEY
    if (typeof embedded === 'string' && embedded.includes('BEGIN PUBLIC KEY')) return embedded
  } catch { /* not generated */ }
  if (process.env.DSH_PRO_DEV_KEYS === '1') {
    try { return fs.readFileSync(path.join(APP_ROOT, 'infra', 'keys', 'public.pem'), 'utf8') } catch { /* fallthrough */ }
  }
  throw new Error('no embedded update public key (run: node infra/embed-key.mjs)')
}

/** Module-level plugin facts — the canonical form the Loader reads. */
export const inject = ['timer']

export default class DesktopUpdates extends Service {
  /** @param {import('@deepseek-ai/cordis').Context} ctx */
  constructor(ctx) {
    super(ctx, 'desktopUpdates')
    this.userData = app.getPath('userData')
    this.checking = false
    // B10 cadence: first check 60s after boot, then every 6h. Disposed with the tree.
    this.ctx.setInterval?.(() => void this.checkNow({ silent: true }), 6 * 3600 * 1000)
    setTimeout(() => void this.checkNow({ silent: true }), 60_000).unref?.()
  }

  /**
   * One check → stage → (prompt) cycle.
   * @param {{silent?: boolean}} [options] - silent: no dialogs unless an update staged.
   * @returns {Promise<object | null>} the staged info, or null.
   */
  async checkNow(options = {}) {
    if (this.checking) return null
    this.checking = true
    try {
      const staged = await this.checkAndStage()
      if (staged === null) {
        if (!options.silent) {
          dialog.showMessageBoxSync({ type: 'info', title: '检查更新', message: '已是最新版本，或暂无可用更新。' })
        }
        return null
      }
      const choice = dialog.showMessageBoxSync({
        type: 'info',
        title: '发现新版本',
        message: `新版本运行时 ${staged.runtimeVersion} 已就绪（${staged.apply.length} 个包）`,
        detail: '重启后生效。要立即重启吗？',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      if (choice === 0) {
        app.relaunch()
        app.exit(0)
      }
      return staged
    } catch (err) {
      console.log(`[pro] desktopUpdates: check failed (${err.message}); staying on current version`)
      return null
    } finally {
      this.checking = false
    }
  }

  /** verify → diff → download+verify → stage (the M2 flow, as a service). */
  async checkAndStage() {
    const cfg = this.config()
    if (!cfg.enabled) return null
    const url = process.env.DSH_PRO_UPDATE_URL?.replace(/\/+$/, '') ?? cfg.url
    if (!url) return null

    const { manifest } = await this.verifyAndFetch(url, cfg.channel)
    if (manifest.schema !== 1 || !Array.isArray(manifest.packages)) throw new Error('unsupported manifest schema')
    const state = this.readState()
    if (typeof manifest.sequence !== 'number' || manifest.sequence <= (state.lastSequence ?? 0)) return null
    const percent = Number(manifest.rollout?.percent ?? 100)
    const bucket = parseInt(crypto.createHash('sha256').update(`${cfg.clientId}:${cfg.channel}`).digest('hex').slice(0, 8), 16) % 100
    if (bucket >= percent) return null

    const installed = this.localIndex()
    const changed = manifest.packages.filter((p) => installed.get(p.name) !== p.version)
    if (changed.length === 0) return null

    const pkgDir = path.join(this.userData, 'staging-update', 'packages')
    fs.rmSync(path.join(this.userData, 'staging-update'), { recursive: true, force: true })
    fs.mkdirSync(pkgDir, { recursive: true })
    await this.downloadAndVerifyAll(changed, pkgDir, url, cfg.channel)

    const info = {
      channel: cfg.channel,
      sequence: manifest.sequence,
      runtimeVersion: manifest.runtimeVersion,
      apply: changed.map((p) => ({ name: p.name, version: p.version, artifact: p.artifact })),
    }
    fs.writeFileSync(path.join(this.userData, 'staging-update', 'staged.json'), `${JSON.stringify(info, null, 2)}\n`)
    console.log(`[pro] desktopUpdates: staged ${changed.length} package(s), sequence ${manifest.sequence}`)
    return info
  }

  config() {
    const file = path.join(this.userData, 'update-config.json')
    let stored = {}
    try { stored = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first run */ }
    if (typeof stored.clientId !== 'string') {
      stored = { enabled: true, channel: 'stable', ...stored, clientId: crypto.randomUUID() }
      fs.mkdirSync(this.userData, { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`)
    }
    return { enabled: true, channel: 'stable', ...stored }
  }

  readState() {
    try { return JSON.parse(fs.readFileSync(path.join(this.userData, 'update-state.json'), 'utf8')) } catch { return {} }
  }

  localIndex() {
    const modules = path.join(APP_ROOT, 'node_modules')
    const index = new Map()
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || isTransient(entry.name)) continue
      if (entry.name.startsWith('@')) {
        for (const scoped of fs.readdirSync(path.join(modules, entry.name), { withFileTypes: true })) {
          if (scoped.isDirectory() && !isTransient(scoped.name)) this.addInstalled(index, path.join(modules, entry.name, scoped.name))
        }
      } else this.addInstalled(index, path.join(modules, entry.name))
    }
    return index
  }

  addInstalled(map, dir) {
    try {
      let text = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      const { name, version } = JSON.parse(text)
      if (typeof name === 'string' && typeof version === 'string') map.set(name, version)
    } catch { /* not a package */ }
  }

  async verifyAndFetch(url, channel) {
    const base = `${url}/${encodeURIComponent(channel)}`
    const [manifestRes, sigRes] = await Promise.all([
      fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(20_000) }),
      fetch(`${base}/manifest.sig`, { signal: AbortSignal.timeout(20_000) }),
    ])
    if (!manifestRes.ok || !sigRes.ok) throw new Error(`manifest fetch failed (${manifestRes.status}/${sigRes.status})`)
    const raw = Buffer.from(await manifestRes.arrayBuffer())
    const sig = Buffer.from(await sigRes.arrayBuffer())
    const end = raw.length > 0 && raw[raw.length - 1] === 0x0a ? raw.length - 1 : raw.length
    if (!crypto.verify(null, raw.subarray(0, end), publicKey(), sig)) {
      throw new Error('manifest signature INVALID — rejecting update')
    }
    return { manifest: JSON.parse(raw.subarray(0, end).toString('utf8')) }
  }

  async downloadAndVerifyAll(packages, pkgDir, url, channel) {
    let cursor = 0
    const base = `${url}/${encodeURIComponent(channel)}/packages`
    const worker = async () => {
      for (;;) {
        const index = cursor++
        if (index >= packages.length) return
        const p = packages[index]
        const artifact = path.join(pkgDir, p.artifact)
        await this.downloadFile(`${base}/${encodeURIComponent(p.artifact)}`, artifact)
        const digest = `sha256-${crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('base64url')}`
        if (digest !== p.integrity) throw new Error(`integrity mismatch for ${p.name}: ${digest}`)
      }
    }
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, packages.length) }, worker))
  }

  downloadFile(url, dest) {
    return new Promise((resolveP, reject) => {
      const timeout = setTimeout(() => reject(new Error('download timed out')), 10 * 60_000)
      fetch(url).then((res) => {
        if (!res.ok) throw new Error(`download HTTP ${res.status} for ${url}`)
        const out = fs.createWriteStream(dest)
        Readable.fromWeb(res.body).pipe(out).on('finish', () => { clearTimeout(timeout); resolveP() }).on('error', reject)
      }).catch(reject)
    })
  }
}

function isTransient(name) {
  return name === '.update-backup' || name.endsWith('.dsh-incoming')
}

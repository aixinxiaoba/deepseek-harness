/**
 * DSH Desktop Pro client updater (design §4).
 *
 * Verifies the publisher's Ed25519 signature over the channel manifest,
 * computes a package-level diff against the installed closure, downloads
 * ONLY changed packages, and stages them. The staged set is applied on the
 * NEXT launch, before the engine boots (nothing swaps under a live Host),
 * with a self-check and full backup/rollback.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { Readable } = require('node:stream')

const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'

/**
 * The update trust anchor (B1). The embedded key is the ONLY source a
 * packaged build trusts; a dev-tree fallback exists solely behind the
 * explicit DSH_PRO_DEV_KEYS=1 opt-in (standalone E2E runs) so the default is
 * fail-closed everywhere — disk-writable key files must never authenticate
 * an update.
 */
function publicKey(appDir) {
  try {
    const embedded = require('./embedded-key.cjs').PUBLIC_KEY
    if (typeof embedded === 'string' && embedded.includes('BEGIN PUBLIC KEY')) return embedded
  } catch { /* not generated yet */ }
  if (process.env.DSH_PRO_DEV_KEYS === '1' && appDir !== undefined) {
    try { return fs.readFileSync(path.join(appDir, 'infra', 'keys', 'public.pem'), 'utf8') } catch { /* fallthrough */ }
  }
  throw new Error('no embedded update public key (run: node infra/embed-key.mjs)')
}

// --- config -----------------------------------------------------------------
function readConfig(userData) {
  const file = path.join(userData, 'update-config.json')
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first run */ }
  if (typeof stored.clientId !== 'string') {
    stored.clientId = crypto.randomUUID()
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ ...defaults(), ...stored }, null, 2)}\n`)
  }
  return { ...defaults(), ...stored }
}
function defaults() {
  return { enabled: true, url: null, channel: 'stable' }
}

function effectiveUrl(userData) {
  const env = process.env.DSH_PRO_UPDATE_URL
  if (env) return env.replace(/\/+$/, '')
  const cfg = readConfig(userData)
  return typeof cfg.url === 'string' && cfg.url ? cfg.url.replace(/\/+$/, '') : null
}

// --- local closure ------------------------------------------------------------
/** name -> version for every installable package under the engine's node_modules. */
function localIndex(engineDir) {
  const modules = path.join(engineDir, 'node_modules')
  const index = new Map()
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || isTransient(entry.name)) continue
    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(path.join(modules, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory() && !isTransient(scoped.name)) addInstalled(index, path.join(modules, entry.name, scoped.name))
      }
    } else {
      addInstalled(index, path.join(modules, entry.name))
    }
  }
  return index
}

/** Apply-time scratch dirs that must never count as installed packages. */
function isTransient(name) {
  return name === '.update-backup' || name.endsWith('.dsh-incoming')
}
function addInstalled(map, dir) {
  try {
    let text = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // tolerate BOM'd manifests
    const { name, version } = JSON.parse(text)
    if (typeof name === 'string' && typeof version === 'string') map.set(name, version)
  } catch { /* not a package */ }
}

// --- manifest -----------------------------------------------------------------
async function verifyAndFetch(url, channel, appDir) {
  const [manifestRes, sigRes] = await Promise.all([
    fetch(`${url}/${encodeURIComponent(channel)}/manifest.json`, { signal: AbortSignal.timeout(20_000) }),
    fetch(`${url}/${encodeURIComponent(channel)}/manifest.sig`, { signal: AbortSignal.timeout(20_000) }),
  ])
  if (!manifestRes.ok || !sigRes.ok) throw new Error(`manifest fetch failed (${manifestRes.status}/${sigRes.status})`)
  // Verify over the RAW bytes as served: the publisher writes canonical + '\n';
  // signing covered the canonical prefix, so strip one trailing newline.
  const raw = Buffer.from(await manifestRes.arrayBuffer())
  const sig = Buffer.from(await sigRes.arrayBuffer())
  const canonical = raw.subarray(0, subarrayEnd(raw))
  const valid = crypto.verify(null, canonical, publicKey(appDir), sig)
  if (!valid) throw new Error('manifest signature INVALID — rejecting update')
  return { manifest: JSON.parse(canonical.toString('utf8')), rawBytes: raw }
}
/** Length of the buffer minus exactly one trailing newline, when present. */
function subarrayEnd(buf) {
  return buf.length > 0 && buf[buf.length - 1] === 0x0a ? buf.length - 1 : buf.length
}

/** Persistent update state (sequence monotonicity, B2). */
function readState(userData) {
  try { return JSON.parse(fs.readFileSync(path.join(userData, 'update-state.json'), 'utf8')) } catch { return {} }
}
function writeState(userData, state) {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(path.join(userData, 'update-state.json'), `${JSON.stringify(state, null, 2)}\n`)
}

// --- check & stage -------------------------------------------------------------
/**
 * Compare the signed manifest against the local closure and stage changed
 * packages. Non-throwing: every failure degrades to "stay on current".
 * Sequence is monotonic (B2): a manifest at or below the last applied
 * sequence is ignored, so a stale or replayed server cannot downgrade.
 * @returns staged manifest on success, else null.
 */
async function checkForUpdates({ engineDir, userData, appDir }) {
  try {
    const cfg = readConfig(userData)
    if (!cfg.enabled) return null
    const url = effectiveUrl(userData)
    if (!url) return null

    const { manifest } = await verifyAndFetch(url, cfg.channel, appDir ?? path.resolve(engineDir, '..', '..', '..'))
    if (manifest.schema !== 1 || !Array.isArray(manifest.packages)) throw new Error('unsupported manifest schema')

    const state = readState(userData)
    if (typeof manifest.sequence !== 'number' || manifest.sequence <= (state.lastSequence ?? 0)) {
      return null
    }

    // Rollout gate: a stable per-client bucket decides exposure.
    const percent = Number(manifest.rollout?.percent ?? 100)
    const bucket = parseInt(crypto.createHash('sha256').update(`${cfg.clientId}:${cfg.channel}`).digest('hex').slice(0, 8), 16) % 100
    if (bucket >= percent) return null

    const installed = localIndex(engineDir)
    const changed = manifest.packages.filter((p) => installed.get(p.name) !== p.version)
    if (changed.length === 0) return null

    const staging = path.join(userData, 'staging-update')
    const pkgDir = path.join(staging, 'packages')
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(pkgDir, { recursive: true })

    // Download + verify with bounded concurrency (B3): multi-package updates
    // must not pay the round-trip latency of a serial loop.
    await downloadAndVerifyAll(changed, pkgDir, url, cfg.channel)

    const stagedInfo = {
      channel: cfg.channel,
      sequence: manifest.sequence,
      runtimeVersion: manifest.runtimeVersion,
      apply: changed.map((p) => ({ name: p.name, version: p.version, artifact: p.artifact })),
    }
    fs.writeFileSync(path.join(staging, 'staged.json'), `${JSON.stringify(stagedInfo, null, 2)}\n`)
    console.log(`[pro] updater: staged ${changed.length} package(s), sequence ${manifest.sequence} (runtime ${manifest.runtimeVersion})`)
    return stagedInfo
  } catch (err) {
    console.log(`[pro] updater: check failed (${err.message}); staying on current version`)
    return null
  }
}

// --- apply (next launch, before engine boot) -------------------------------------
/**
 * Apply a staged update into the engine closure with per-package backup and
 * rollback. Extraction happens inside node_modules for same-volume renames.
 * @returns applied staged info, or null.
 */
function applyStaged({ engineDir, userData }) {
  const staging = path.join(userData, 'staging-update')
  const marker = path.join(staging, 'staged.json')
  if (!fs.existsSync(marker)) return null
  let info
  try { info = JSON.parse(fs.readFileSync(marker, 'utf8')) } catch { fs.rmSync(staging, { recursive: true, force: true }); return null }

  const modules = path.join(engineDir, 'node_modules')
  // Backups live BESIDE node_modules (same volume): cross-volume renames
  // throw EXDEV on Windows, and userData is usually on a different drive.
  const backupRoot = path.join(engineDir, '.update-backup')
  fs.rmSync(backupRoot, { recursive: true, force: true })
  fs.mkdirSync(backupRoot, { recursive: true })
  const replaced = []

  try {
    for (const p of info.apply) {
      const dest = path.join(modules, ...p.name.split('/'))
      const tgz = path.join(staging, 'packages', p.artifact)
      if (!fs.existsSync(tgz)) throw new Error(`staged artifact missing: ${p.name}`)
      // Extract beside the destination (same volume), then swap. The tmp dir
      // must never survive a failure: a leftover would poison the next index
      // scan (it looks like an installed package).
      const tmp = `${dest}.dsh-incoming`
      fs.rmSync(tmp, { recursive: true, force: true })
      try {
        fs.mkdirSync(tmp, { recursive: true })
        const extract = spawnSync(TAR, ['-xzf', tgz, '-C', tmp], { stdio: 'pipe' })
        if (extract.status !== 0) throw new Error(`extract failed for ${p.name}: ${extract.stderr}`)
        const sanity = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'))
        if (sanity.name !== p.name || sanity.version !== p.version) {
          throw new Error(`artifact identity mismatch: got ${sanity.name}@${sanity.version}, expected ${p.name}@${p.version}`)
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        let backup = null
        if (fs.existsSync(dest)) {
          backup = path.join(backupRoot, p.name.replaceAll('/', '__'))
          fs.mkdirSync(path.dirname(backup), { recursive: true })
          fs.renameSync(dest, backup)
        }
        fs.renameSync(tmp, dest)
        replaced.push({ p, backup, dest })
      } catch (err) {
        fs.rmSync(tmp, { recursive: true, force: true })
        throw err
      }
    }

    // Self-check: every applied package now reports its manifest version, and
    // the engine's critical entries survive.
    const after = localIndex(engineDir)
    for (const r of replaced) {
      if (after.get(r.p.name) !== r.p.version) throw new Error(`post-apply version mismatch for ${r.p.name}`)
    }
    for (const critical of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver']) {
      if (!after.has(critical)) throw new Error(`critical package missing after apply: ${critical}`)
    }
    if (!fs.existsSync(path.join(modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
      throw new Error('engine CLI entry missing after apply')
    }

    fs.rmSync(staging, { recursive: true, force: true })
    fs.rmSync(backupRoot, { recursive: true, force: true })
    writeState(userData, { lastSequence: info.sequence })
    console.log(`[pro] updater: applied sequence ${info.sequence} (${replaced.length} package(s), runtime ${info.runtimeVersion})`)
    return info
  } catch (err) {
    console.log(`[pro] updater: apply failed (${err.message}); rolling back`)
    for (const r of [...replaced].reverse()) {
      try {
        fs.rmSync(r.dest, { recursive: true, force: true })
        if (r.backup !== null && fs.existsSync(r.backup)) fs.renameSync(r.backup, r.dest)
      } catch { /* best effort */ }
    }
    fs.rmSync(staging, { recursive: true, force: true })
    return null
  }
}

// --- helpers ----------------------------------------------------------------------
/** Concurrent download+verify pool size. */
const DOWNLOAD_CONCURRENCY = 4

/**
 * Download and sha256-verify every changed package with a bounded worker
 * pool. First failure rejects the whole stage (the caller cleans staging).
 */
async function downloadAndVerifyAll(packages, pkgDir, url, channel) {
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= packages.length) return
      const p = packages[index]
      const artifact = path.join(pkgDir, p.artifact)
      await downloadFile(`${url}/${encodeURIComponent(channel)}/packages/${encodeURIComponent(p.artifact)}`, artifact)
      const digest = hashFileB64u(artifact)
      if (digest !== p.integrity) throw new Error(`integrity mismatch for ${p.name}: ${digest}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, packages.length) }, worker))
}

function downloadFile(url, dest) {
  return new Promise((resolveP, reject) => {
    const timeout = setTimeout(() => reject(new Error('download timed out')), 10 * 60_000)
    fetch(url).then((res) => {
      if (!res.ok) throw new Error(`download HTTP ${res.status} for ${url}`)
      const out = fs.createWriteStream(dest)
      Readable.fromWeb(res.body).pipe(out).on('finish', () => { clearTimeout(timeout); resolveP() }).on('error', reject)
    }).catch(reject)
  })
}

function hashFileB64u(file) {
  return `sha256-${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64url')}`
}

module.exports = { checkForUpdates, applyStaged, localIndex, readConfig }

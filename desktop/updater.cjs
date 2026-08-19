/**
 * Runtime updater for the dsh desktop shell.
 *
 * The dsh engine lives at <resources>/dsh. Updates arrive as a versioned zip
 * (see desktop/build-update.mjs) hosted on the update server as static files.
 *
 * Flow:
 *  - On startup, `applyStagedUpdate` swaps in any fully-downloaded update from a
 *    previous session (the host is not running yet, so the swap is atomic-safe).
 *  - After the UI is up, `checkForUpdate` compares the local runtime version
 *    against the server manifest, downloads + verifies (sha256) + extracts a
 *    newer runtime into the staged dir, then asks the caller to prompt the user
 *    to restart.
 *
 * Update URL resolution: DSH_UPDATE_URL env var first, else <userData>/config.json
 * `updateUrl`. Empty/unset disables updates.
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { Readable } = require('node:stream')

const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
const HOST_BIN_REL = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']

function localRuntimeDir() {
  // DSH_RUNTIME_DIR overrides the bundled location (testing/debug aid).
  if (process.env.DSH_RUNTIME_DIR) return process.env.DSH_RUNTIME_DIR
  return path.join(process.resourcesPath, 'dsh')
}

function readLocalVersion() {
  try {
    const raw = fs.readFileSync(path.join(localRuntimeDir(), 'version.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.runtimeVersion === 'string' ? parsed.runtimeVersion : null
  } catch {
    return null
  }
}

function readUpdateUrl(userData) {
  if (process.env.DSH_UPDATE_URL) return process.env.DSH_UPDATE_URL.replace(/\/+$/, '')
  try {
    const raw = fs.readFileSync(path.join(userData, 'config.json'), 'utf8')
    const cfg = JSON.parse(raw)
    if (typeof cfg.updateUrl === 'string' && cfg.updateUrl) return cfg.updateUrl.replace(/\/+$/, '')
  } catch {
    /* no config yet */
  }
  return null
}

function stagedDir(userData) {
  return path.join(userData, 'staged-update')
}

/**
 * If a previous session downloaded an update, swap it in place of the bundled
 * runtime. Returns the newly applied version, or null when nothing was staged.
 */
function applyStagedUpdate(userData) {
  const staged = stagedDir(userData)
  if (!fs.existsSync(staged)) return null
  const stagedBin = path.join(staged, ...HOST_BIN_REL)
  if (!fs.existsSync(stagedBin)) {
    fs.rmSync(staged, { recursive: true, force: true })
    return null
  }
  const dest = localRuntimeDir()
  const backup = `${dest}.old`
  try {
    fs.rmSync(backup, { recursive: true, force: true })
    fs.renameSync(dest, backup)
    try {
      // Cross-volume safe: userData (C:) and resources (D:) usually differ, and
      // rename cannot move a directory across volumes (EXDEV). Copy instead.
      fs.cpSync(staged, dest, { recursive: true })
    } catch (copyErr) {
      fs.rmSync(dest, { recursive: true, force: true })
      throw copyErr
    }
    fs.rmSync(backup, { recursive: true, force: true })
    fs.rmSync(staged, { recursive: true, force: true })
  } catch (err) {
    console.log(`updater: swap failed (${err.code ?? err.message}), restoring previous runtime`)
    // Swap failed — restore the old runtime.
    if (fs.existsSync(backup) && !fs.existsSync(dest)) fs.renameSync(backup, dest)
    fs.rmSync(backup, { recursive: true, force: true })
    return null
  }
  const version = readLocalVersion()
  console.log(`updater: applied staged runtime ${version}`)
  return version
}

/**
 * Check the update server and stage a newer runtime if one exists.
 * Never throws: all failures degrade to "stay on current version".
 * @returns the staged runtime version, or null.
 */
async function checkForUpdate(userData) {
  const base = readUpdateUrl(userData)
  if (!base) return null
  const local = readLocalVersion()
  let manifest
  try {
    const res = await fetch(`${base}/update.json`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`)
    manifest = await res.json()
  } catch (err) {
    console.log(`updater: manifest fetch failed (${err.message})`)
    return null
  }
  if (!manifest || typeof manifest.runtimeVersion !== 'string' || typeof manifest.sha256 !== 'string') return null
  if (local === manifest.runtimeVersion) return null

  const staged = stagedDir(userData)
  const tmpZip = path.join(userData, 'update.tmp')
  try {
    await downloadFile(`${base}/${manifest.url}`, tmpZip)
    const hash = await sha256File(tmpZip)
    if (hash !== manifest.sha256) throw new Error(`sha256 mismatch (${hash.slice(0, 12)}…)`)
    fs.rmSync(staged, { recursive: true, force: true })
    fs.mkdirSync(staged, { recursive: true })
    const extract = spawnSync(TAR, ['-xf', tmpZip, '-C', staged], { stdio: 'inherit' })
    if (extract.status !== 0) throw new Error(`extract failed (status ${extract.status})`)
    if (!fs.existsSync(path.join(staged, ...HOST_BIN_REL))) throw new Error('staged runtime missing dsh bin')
    fs.rmSync(tmpZip, { force: true })
    console.log(`updater: staged ${manifest.runtimeVersion} (${manifest.sha256.slice(0, 12)}…)`)
    return manifest.runtimeVersion
  } catch (err) {
    console.log(`updater: update failed (${err.message}), staying on ${local}`)
    fs.rmSync(tmpZip, { force: true })
    fs.rmSync(staged, { recursive: true, force: true })
    return null
  }
}

function downloadFile(url, dest) {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error('download timed out')), 10 * 60_000)
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`download HTTP ${res.status}`)
        const out = fs.createWriteStream(dest)
        Readable.fromWeb(res.body)
          .pipe(out)
          .on('finish', () => {
            clearTimeout(timeout)
            resolvePromise()
          })
          .on('error', reject)
      })
      .catch(reject)
  })
}

function sha256File(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

module.exports = { applyStagedUpdate, checkForUpdate, readLocalVersion }

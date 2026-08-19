/**
 * afterPack gate (P2): refuse to ship an application archive whose runtime
 * closure is incomplete. Every check targets the PHYSICAL tree under
 * app.asar.unpacked — the only tree the in-process boot, profile-fallback
 * junctions, and updater can actually use.
 */
const fs = require('node:fs')
const path = require('node:path')
// Runs in the builder's plain Node: inspecting INSIDE the archive needs the
// asar library, not fs (the asar path is an archive file, not a directory).
const asarLib = require('@electron/asar')

/** Best-effort recursive delete that never throws. */
function rmTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

module.exports = function verifyPackagedRuntime(context) {
  const { appOutDir, electronPlatformName: platform } = context
  const resources = path.join(appOutDir, 'resources')
  const unpacked = path.join(resources, 'app.asar.unpacked')
  const asarFile = path.join(resources, 'app.asar')

  // --- production slimming (M3) --------------------------------------------
  // 1. Non-win32 native prebuilds are dead weight on a win32 build.
  if (platform === 'win32') {
    for (const foreign of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linux-loong64', 'freebsd-x64', 'openbsd-x64', 'win32-arm64', 'win32-ia32']) {
      rmTree(path.join(unpacked, 'node_modules', 'node-pty', 'prebuilds', foreign))
    }
  }
  // 2. Source maps are debugging artifacts; production never loads them.
  let prunedMaps = 0
  let prunedBytes = 0
  for (const file of fs.readdirSync(path.join(unpacked, 'node_modules'), { recursive: true })) {
    if (typeof file !== 'string' || !file.endsWith('.map')) continue
    const full = path.join(unpacked, 'node_modules', file)
    try {
      prunedBytes += fs.statSync(full).size
      fs.rmSync(full, { force: true })
      prunedMaps += 1
    } catch { /* best effort */ }
  }
  console.log(`slim: pruned foreign prebuilds + ${prunedMaps} source maps (${(prunedBytes / 1024 / 1024).toFixed(1)} MB)`)

  const mustExist = (file, what) => {
    if (!fs.existsSync(file)) throw new Error(`packaged-runtime gate: ${what} missing: ${file}`)
  }

  if (platform === 'win32') {
    mustExist(path.join(appOutDir, 'DSH Desktop Pro.exe'), 'application executable')
  }

  // The asar itself plus the shell modules inside it. listPackage returns
  // platform-separated paths with a leading separator (\main.cjs on win32).
  mustExist(asarFile, 'application asar')
  const packedEntries = new Set(
    asarLib.listPackage(asarFile).map((p) => p.replace(/^[\\/]+/, '').replaceAll('\\', '/')),
  )
  for (const file of ['main.cjs', 'updater.cjs', 'log.cjs', 'embedded-key.cjs']) {
    if (!packedEntries.has(file)) throw new Error(`packaged-runtime gate: shell module ${file} missing from asar`)
  }

  // The physical engine closure.
  const modules = path.join(unpacked, 'node_modules')
  mustExist(modules, 'physical node_modules')
  mustExist(path.join(modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'DSH CLI bootstrap')
  mustExist(path.join(modules, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'), 'app-boot entry')
  mustExist(path.join(modules, '@deepseek-ai', 'dsh-host-webserver', 'lib', 'index.js'), 'webserver package')
  mustExist(path.join(modules, '@deepseek-ai', 'dsh-host-directory-picker', 'lib', 'index.js'), 'picker seam')
  mustExist(path.join(modules, '@deepseek-ai', 'dsh-client-ui-directory-picker-native', 'lib'), 'picker native surface')
  // Peer-closure packages: electron-builder's tree walk drops peers that are
  // not also direct dependencies, and the engine needs all five at boot.
  for (const peer of ['cordis', 'cordis-plugin-group', 'cordis-plugin-include', 'cordis-plugin-loader', 'cordis-plugin-timer']) {
    mustExist(path.join(modules, '@deepseek-ai', peer, 'package.json'), `engine peer dependency ${peer}`)
  }

  // Our shell plugin must be a real (junction-targetable) directory.
  mustExist(path.join(modules, 'picker-electron', 'index.js'), 'picker-electron shell plugin')

  // Native binaries the Windows runtime loads. node-pty 1.1 ships Node-API
  // PREBUILDS (prebuilds/win32-x64/conpty.node), not a build/Release tree —
  // which is exactly why npmRebuild:false is safe.
  mustExist(path.join(modules, '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'), 'koffi FFI binary')
  mustExist(path.join(modules, 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'), 'node-pty win32-x64 prebuild')

  // The embedded trust anchor must carry a real Ed25519 public key.
  let key = null
  for (const candidate of ['embedded-key.cjs', '\\embedded-key.cjs', '/embedded-key.cjs']) {
    try { key = asarLib.extractFile(asarFile, candidate).toString('utf8'); break } catch { /* next form */ }
  }
  if (key === null || !key.includes('BEGIN PUBLIC KEY')) {
    throw new Error('packaged-runtime gate: embedded-key.cjs missing or has no Ed25519 public key')
  }

  console.log(`packaged-runtime gate: OK (${path.basename(appOutDir)})`)
}

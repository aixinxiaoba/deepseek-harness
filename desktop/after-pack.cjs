/**
 * electron-builder afterPack hook.
 *
 * electron-builder's extraResources filtering (which respects .gitignore and
 * drops node_modules) cannot be trusted to carry the 600MB dsh runtime, so we
 * copy it directly into the app's resources here — after the app directory is
 * assembled and before the zip/portable targets are produced. This bypasses
 * every file filter.
 *
 * Bundled layout (matches desktop/main.js):
 *   resources/dsh/            -> the self-contained dsh runtime (.tools/dsh-runtime)
 *   resources/node/node.exe   -> the standalone Node used to launch the host
 */
const fs = require('node:fs')
const path = require('node:path')

module.exports = async function afterPack(context) {
  const { appOutDir } = context
  const repoRoot = path.resolve(__dirname, '..')
  const resources = path.join(appOutDir, 'resources')

  // dsh runtime.
  const runtimeSource = path.join(repoRoot, '.tools', 'dsh-runtime')
  const runtimeDest = path.join(resources, 'dsh')
  if (!fs.existsSync(runtimeSource)) {
    throw new Error(`dsh runtime missing at ${runtimeSource}. Run: node desktop/build-runtime.mjs`)
  }
  fs.rmSync(runtimeDest, { recursive: true, force: true })
  fs.cpSync(runtimeSource, runtimeDest, { recursive: true })
  console.log(`afterPack: bundled dsh runtime into ${runtimeDest}`)

  // Standalone Node runtime (only node.exe is needed to launch the host).
  const toolsNode = path.join(repoRoot, '.tools', 'node-v22.23.2-win-x64', 'node.exe')
  const nodeDest = path.join(resources, 'node')
  fs.rmSync(nodeDest, { recursive: true, force: true })
  fs.mkdirSync(nodeDest, { recursive: true })
  fs.copyFileSync(toolsNode, path.join(nodeDest, 'node.exe'))
  console.log(`afterPack: bundled node into ${nodeDest}`)
}

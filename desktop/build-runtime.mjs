#!/usr/bin/env node
/**
 * Build the self-contained dsh runtime for the desktop app.
 *
 * Packs the dsh + vendor release families into tarballs (via the repo's own
 * release scripts), then installs every tarball into a clean consumer directory
 * with plain `npm install`. This is the mechanism the repo itself proves with
 * `verify-packed-install`: because npm resolves the full peer/dependency graph,
 * the resulting closure is complete — unlike `pnpm deploy`, which drops
 * workspace peer packages.
 *
 * Output: <repo>/.tools/dsh-runtime (a self-contained runnable dsh).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const toolsNodeDir = resolveNodeDir(root)
const packDirs = [join(root, '.tools', 'npm', 'dsh'), join(root, '.tools', 'npm', 'vendor')]
const consumerRoot = join(root, '.tools', 'dsh-runtime')
const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'

/** Find the standalone Node runtime kept in .tools (for its npm). */
function resolveNodeDir(base) {
  const tools = join(base, '.tools')
  for (const entry of readdirSync(tools, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('node-v')) {
      const cand = join(tools, entry.name)
      if (process.platform === 'win32' && existsSync(join(cand, 'npm.cmd'))) return cand
      if (process.platform !== 'win32' && existsSync(join(cand, 'bin', 'npm'))) return cand
    }
  }
  throw new Error(`no standalone Node runtime found under ${tools}/node-*`)
}

function readTgzManifest(tgz) {
  const out = execFileSync(tar, ['-xOf', tgz, 'package/package.json'], { encoding: 'utf8' })
  return JSON.parse(out)
}

// Collect every packed tarball from both families.
const deps = {}
for (const dir of packDirs) {
  const tgzs = readdirSync(dir).filter((f) => f.endsWith('.tgz')).sort()
  if (tgzs.length === 0) throw new Error(`${dir} holds no packed tarball`)
  for (const file of tgzs) {
    const tgz = join(dir, file)
    const { name, version } = readTgzManifest(tgz)
    deps[name] = pathToFileURL(tgz).href
    console.log(`  pack ${name}@${version}`)
  }
}
console.log(`runtime: ${Object.keys(deps).length} packages`)

// Clean consumer project depending on every tarball by file: URL.
rmSync(consumerRoot, { recursive: true, force: true })
mkdirSync(consumerRoot, { recursive: true })
writeFileSync(
  join(consumerRoot, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-desktop-runtime',
      version: '0.0.0',
      private: true,
      dependencies: deps,
    },
    null,
    2,
  )}\n`,
)

// Install with plain npm. Drive npm through its JS entry with the standalone
// Node (Windows cannot spawn .cmd shims directly via child_process).
//
// No --omit=optional: koffi ships its prebuilt binary as the optional platform
// package @koromix/koffi-win32-x64, which must install for the host to load
// native FFI on Windows. Linux-only optional packages (e.g. the Landlock
// launcher) are skipped automatically by their `os` constraint on win32.
const nodeExe = process.platform === 'win32' ? join(toolsNodeDir, 'node.exe') : join(toolsNodeDir, 'bin', 'node')
const npmCli = join(toolsNodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
console.log(`runtime: npm install into ${consumerRoot}`)
const result = spawnSync(
  nodeExe,
  [npmCli, 'install', '--no-audit', '--no-fund', '--package-lock=false'],
  { cwd: consumerRoot, stdio: 'inherit' },
)
if (result.status !== 0) process.exit(result.status)

// Prune the SDK-distributed Claude Code CLI payloads (@anthropic-ai/
// claude-agent-sdk-<platform>, ~253MB each): dsh's subagent-claude-code
// provider resolves the user's NATIVE `claude` executable in production and
// passes it as pathToClaudeCodeExecutable, so the bundled binaries are only
// an upstream test fixture (their README flags them for removal). The
// delegation code itself (claude-agent-sdk, ~4MB) stays functional.
const prunable = readdirSync(join(consumerRoot, 'node_modules', '@anthropic-ai'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('claude-agent-sdk-'))
  .map((e) => join(consumerRoot, 'node_modules', '@anthropic-ai', e.name))
for (const dir of prunable) {
  const sizeMB = Math.round(statSync(dir).size / 1024 / 1024)
  rmSync(dir, { recursive: true, force: true })
  console.log(`runtime: pruned Claude Code CLI payload ${basename(dir)} (-${sizeMB}MB)`)
}

// Remove the consumer manifest: electron-builder reads the top-level
// package.json's dependencies to prune node_modules when copying
// extraResources, and our file: tarball URLs resolve to nothing — so it drops
// every package. The runtime does not need this manifest at boot (the dsh CLI
// reads its own package.json inside node_modules), so delete it to make the
// whole closure copy verbatim (the bundled Node dir, which has no manifest,
// already proves this behavior).
rmSync(join(consumerRoot, 'package.json'))
console.log(`runtime: consumer manifest removed, closure ready at ${consumerRoot}`)
process.exit(0)

#!/usr/bin/env node
/**
 * Delta update publisher (design §4).
 *
 * Scans the engine dependency closure, diffs it against the previously
 * published index, packs ONLY changed packages, and writes a signed
 * channel bundle:
 *
 *   <out>/<channel>/
 *     manifest.json      packages list (name/version/integrity)
 *     manifest.sig       Ed25519 over the manifest's canonical bytes
 *     packages/*.tgz     changed packages only (typically a handful)
 *     index.json         server-side diff state for the NEXT publish
 *
 * Usage:
 *   node infra/publish.mjs [--channel stable] [--sequence N] [--out .tools/updates]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { sign as edSign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const engineModules = join(root, 'node_modules')
const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'

const { values } = parseArgs({
  options: {
    channel: { type: 'string' },
    sequence: { type: 'string' },
    out: { type: 'string' },
    note: { type: 'string' },
  },
})
const channel = values.channel ?? 'stable'
const outRoot = resolve(root, values.out ?? '.tools/updates')
const channelDir = join(outRoot, channel)

/** All installable packages in the closure: name -> {version, dir}. */
function scanClosure() {
  const pkgs = new Map()
  for (const entry of readdirSync(engineModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || isTransient(entry.name)) continue
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(join(engineModules, entry.name), { withFileTypes: true })) {
        if (!scoped.isDirectory() || isTransient(scoped.name)) continue
        addPackage(pkgs, join(engineModules, entry.name, scoped.name))
      }
    } else {
      addPackage(pkgs, join(engineModules, entry.name))
    }
  }
  return pkgs
}

/** Apply-time scratch dirs that must never count as closure members. */
function isTransient(name) {
  return name === '.update-backup' || name.endsWith('.dsh-incoming')
}

function addPackage(map, dir) {
  const manifestFile = join(dir, 'package.json')
  if (!existsSync(manifestFile)) return
  try {
    const { name, version } = JSON.parse(readJsonNoBom(manifestFile))
    if (typeof name !== 'string' || typeof version !== 'string') return
    map.set(name, { version, dir })
  } catch {
    /* unreadable manifest: not an installable package */
  }
}

/** package.json bytes as JSON text with any UTF-8 BOM stripped (PS tooling writes BOMs). */
function readJsonNoBom(file) {
  let text = readFileSync(file, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text
}

/** File-name mangling: '@deepseek-ai/dsh-agent'@v -> 'deepseek-ai__dsh-agent@0.1.0.tgz'. */
function artifactName(name, version) {
  return `${name.replaceAll('/', '__')}@${version}.tgz`
}

function sha256File(file) {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return `sha256-${hash.digest('base64url')}`
}

function packPackage(dir, outFile) {
  rmSync(outFile, { force: true })
  const result = spawnSync(TAR, ['-czf', outFile, '-C', dir, '.'], { stdio: 'pipe' })
  if (result.status !== 0) throw new Error(`tar failed for ${dir}: ${result.stderr}`)
}

// --- publish ----------------------------------------------------------------
const closure = scanClosure()
const prevIndexFile = join(channelDir, 'index.json')
const prevIndex = existsSync(prevIndexFile)
  ? new Map(Object.entries(JSON.parse(readFileSync(prevIndexFile, 'utf8')).packages))
  : new Map()

const changed = []
const removed = []
// index.json stores name -> version (a plain string).
for (const [name, { version }] of closure) {
  if (prevIndex.get(name) !== version) changed.push(name)
}
for (const name of prevIndex.keys()) {
  if (!closure.has(name)) removed.push(name)
}
if (removed.length > 0) console.log(`publish: removed packages: ${removed.join(', ')}`)

mkdirSync(join(channelDir, 'packages'), { recursive: true })
const manifestPackages = []
let packedBytes = 0
for (const name of [...closure.keys()].sort()) {
  const { version } = closure.get(name)
  const artifact = join(channelDir, 'packages', artifactName(name, version))
  if (changed.includes(name) || !existsSync(artifact)) {
    packPackage(closure.get(name).dir, artifact)
    packedBytes += statSync(artifact).size
  }
  manifestPackages.push({ name, version, integrity: sha256File(artifact), artifact: artifactName(name, version) })
}

// Canonical manifest bytes: sorted keys, no incidental whitespace.
const sequence = Number(values.sequence ?? readPrevSequence() + 1)
const manifest = {
  schema: 1,
  channel,
  sequence,
  runtimeVersion: closure.get('@deepseek-ai/dsh')?.version ?? 'unknown',
  publishedAt: new Date().toISOString(),
  rollout: { percent: 100 },
  notes: values.note ?? '',
  packages: manifestPackages,
}
const canonical = JSON.stringify(manifest)
const privateKey = readFileSync(join(root, 'infra', 'keys', 'private.pem'), 'utf8')
writeFileSync(join(channelDir, 'manifest.json'), `${canonical}\n`)
writeFileSync(join(channelDir, 'manifest.sig'), edSign(null, Buffer.from(canonical, 'utf8'), privateKey))

// Server-side diff state for the next publish (never shipped as truth; the
// signed manifest is).
writeFileSync(join(channelDir, 'index.json'), `${JSON.stringify({
  sequence,
  packages: Object.fromEntries([...closure.entries()].map(([name, { version }]) => [name, version])),
})}\n`)
// Client-embedded public key copy (the packaged build inlines it).
const publicKey = readFileSync(join(root, 'infra', 'keys', 'public.pem'), 'utf8')
writeFileSync(join(outRoot, 'update-public.pem'), publicKey)

function readPrevSequence() {
  if (!existsSync(prevIndexFile)) return 0
  return JSON.parse(readFileSync(prevIndexFile, 'utf8')).sequence ?? 0
}

// B9: artifacts not referenced by the current manifest are unreachable by any
// client (updates always fetch the CURRENT artifact for a changed package),
// so prune them to keep the bundle bounded.
const referenced = new Set(manifestPackages.map((p) => p.artifact))
const packagesDir = join(channelDir, 'packages')
for (const file of readdirSync(packagesDir)) {
  if (!referenced.has(file)) {
    rmSync(join(packagesDir, file), { force: true })
    console.log(`publish: pruned unreferenced artifact ${file}`)
  }
}

console.log(`publish: channel=${channel} sequence=${sequence} packages=${closure.size}`)
console.log(`publish: changed=${changed.length} removed=${removed.length} packed=${(packedBytes / 1024 / 1024).toFixed(1)}MB`)
if (changed.length > 0 && changed.length <= 12) console.log(`publish: changed packages: ${changed.join(', ')}`)
console.log(`publish: bundle at ${channelDir}`)

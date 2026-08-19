#!/usr/bin/env node
/**
 * Sync the engine's full @deepseek-ai/* closure into explicit direct
 * dependencies (the DSH Desktop packaging lesson).
 *
 * electron-builder's dependency walk includes only what it can reach through
 * regular `dependencies` edges. Many engine packages are pure PEERS of their
 * consumers (dsh-timeout, dsh-scope, …), so an implicit tree loses them and
 * the packaged app dies at plugin-import time. Declaring every installed
 * @deepseek-ai/* package as a direct dependency (exact installed version)
 * makes the physical flat tree and the packaged tree identical.
 *
 * Idempotent: rewrites only the engine block, preserving foreign entries.
 * Usage: node infra/sync-engine-deps.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifestFile = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))

const engine = new Map()
const scoped = join(root, 'node_modules', '@deepseek-ai')
for (const entry of readdirSync(scoped, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.endsWith('.dsh-incoming')) continue
  try {
    let text = readFileSync(join(scoped, entry.name, 'package.json'), 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const { name, version } = JSON.parse(text)
    if (typeof name === 'string' && typeof version === 'string') engine.set(name, version)
  } catch { /* not a package */ }
}

const deps = { ...manifest.dependencies }
// Engine block first (sorted), then every non-engine dependency untouched.
const next = {}
for (const [name, version] of [...engine.entries()].sort()) next[name] = version
for (const [name, spec] of Object.entries(deps)) {
  if (!name.startsWith('@deepseek-ai/')) next[name] = spec
}
manifest.dependencies = next
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`sync-engine-deps: declared ${engine.size} @deepseek-ai packages as direct dependencies`)

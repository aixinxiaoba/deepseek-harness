#!/usr/bin/env node
/**
 * Build the distributable runtime update bundle for the desktop app.
 *
 * Stamps a version into the self-contained runtime, packs it into
 * `.tools/update/dsh-runtime-<runtimeVersion>.zip`, and writes `update.json`
 * next to it. Host `update.json` + the zip as static files on your update
 * server; the client resolves `url` relative to its configured UPDATE_URL base.
 *
 * Usage:
 *   node desktop/build-update.mjs [--version <runtimeVersion>]
 * Default runtimeVersion: `0.1.0-rc.5.<yyyymmdd>`.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const runtimeDir = join(root, '.tools', 'dsh-runtime')
const outDir = join(root, '.tools', 'update')
const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'

const { values } = parseArgs({ options: { version: { type: 'string' } } })
const today = new Date().toISOString().slice(0, 10).replaceAll('-', '')
const runtimeVersion = values.version ?? `0.1.0-rc.5.${today}`

if (!existsSync(runtimeDir)) {
  throw new Error(`runtime missing at ${runtimeDir}. Run: node desktop/build-runtime.mjs`)
}

// Stamp the version inside the runtime so clients can compare local vs remote.
writeFileSync(join(runtimeDir, 'version.json'), `${JSON.stringify({ runtimeVersion }, null, 2)}\n`)
console.log(`runtime: stamped version.json (${runtimeVersion})`)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const zipName = `dsh-runtime-${runtimeVersion}.zip`
const zipPath = join(outDir, zipName)

console.log(`runtime: packing ${zipName} ...`)
const pack = spawnSync(tar, ['-cf', zipPath, '--format', 'zip', '-C', runtimeDir, '.'], { stdio: 'inherit' })
if (pack.status !== 0) throw new Error(`tar failed to create ${zipPath} (status ${pack.status})`)

const sha256 = await hashFile(zipPath)
const size = (await import('node:fs')).statSync(zipPath).size
writeFileSync(
  join(outDir, 'update.json'),
  `${JSON.stringify(
    {
      version: 1,
      runtimeVersion,
      url: zipName,
      sha256,
      size,
      notes: '',
    },
    null,
    2,
  )}\n`,
)
console.log(`runtime: ${zipName} (${(size / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…)`)
console.log(`update manifest written to ${join(outDir, 'update.json')}`)

/** SHA-256 of a file, streaming. */
function hashFile(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

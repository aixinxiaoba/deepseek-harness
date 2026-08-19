#!/usr/bin/env node
/**
 * Static server for update bundles (dev/E2E). Serves infra/publish.mjs output:
 *
 *   GET /<channel>/manifest.json | manifest.sig | index.json
 *   GET /<channel>/packages/<artifact>
 *
 * Usage: node infra/serve-updates.mjs [--root .tools/updates] [--port 8941]
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({ options: { root: { type: 'string' }, port: { type: 'string' } } })
const serveRoot = resolve(root, values.root ?? '.tools/updates')
const port = Number(values.port ?? 8941)

const MIME = { '.json': 'application/json', '.tgz': 'application/gzip', '.sig': 'application/octet-stream' }

createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  const file = join(serveRoot, url)
  if (!file.startsWith(serveRoot) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => {
  console.log(`update server: http://127.0.0.1:${port} serving ${serveRoot}`)
})

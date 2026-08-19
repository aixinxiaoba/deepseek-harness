#!/usr/bin/env node
/**
 * Minimal static file server for the update directory — lets you test the
 * runtime update flow locally (and can be pointed at any directory on a VPS).
 *
 * Usage:
 *   node desktop/serve-update.mjs [--dir .tools/update] [--port 8931]
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { dir: { type: 'string' }, port: { type: 'string' } } })
const root = resolve(import.meta.dirname, '..')
const serveDir = resolve(root, values.dir ?? '.tools/update')
const port = Number(values.port ?? 8931)

const MIME = {
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.html': 'text/html',
}

createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  const file = join(serveDir, url)
  if (!file.startsWith(serveDir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => {
  console.log(`update server: http://127.0.0.1:${port} serving ${serveDir}`)
})

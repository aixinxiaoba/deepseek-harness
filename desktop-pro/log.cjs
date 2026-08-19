/**
 * Rotating main-process logs (B7).
 *
 * Two streams under <userData>/logs: full (dsh-YYYY-MM-DD.log) and errors
 * (dsh-YYYY-MM-DD.error.log). Rotation at 10 MiB (suffix -N), retention 7
 * days, directory cap 200 MiB (oldest first). console.log/error/warn are
 * redirected here so every subsystem that logs lands in the same place.
 */
const fs = require('node:fs')
const path = require('node:path')

const MAX_FILE_BYTES = 10 * 1024 * 1024
const RETENTION_DAYS = 7
const MAX_DIR_BYTES = 200 * 1024 * 1024

let logsDir = null

/** Install the redirects. Call once, before anything worth logging happens. */
function init(userData) {
  logsDir = path.join(userData, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const stamp = () => new Date().toISOString()
  const write = (stream, file, line) => {
    try {
      fs.appendFileSync(path.join(logsDir, file), `[${stamp()}] ${line}\n`)
      rotateIfNeeded(file)
    } catch { /* logging must never take the app down */ }
  }
  const origLog = console.log.bind(console)
  const origErr = console.error.bind(console)
  console.log = (...args) => { origLog(...args); write('out', dayFile(), args.join(' ')) }
  console.info = console.log
  console.warn = (...args) => { origErr(...args); write('err', dayFile(true), args.join(' ')) }
  console.error = (...args) => { origErr(...args); write('err', dayFile(true), args.join(' ')) }
  enforceRetention()
  console.log(`[pro] logging to ${logsDir}`)
  return { dir: logsDir }
}

function dayFile(isError = false) {
  const day = new Date().toISOString().slice(0, 10)
  return `dsh-${day}${isError ? '.error' : ''}.log`
}

/** Rotate a file out when it crosses the size bound (dsh-X.log → dsh-X-1.log …). */
function rotateIfNeeded(file) {
  const full = path.join(logsDir, file)
  if (fs.statSync(full).size <= MAX_FILE_BYTES) return
  const base = file.replace(/\.log$/, '')
  let n = 1
  while (fs.existsSync(path.join(logsDir, `${base}-${n}.log`))) n += 1
  fs.renameSync(full, path.join(logsDir, `${base}-${n}.log`))
}

/** 7-day retention plus a 200 MiB directory cap, oldest first. */
function enforceRetention() {
  try {
    const entries = fs.readdirSync(logsDir).map((name) => {
      const stat = fs.statSync(path.join(logsDir, name))
      return { name, mtime: stat.mtimeMs, size: stat.size }
    }).sort((a, b) => a.mtime - b.mtime)
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000
    let total = entries.reduce((sum, e) => sum + e.size, 0)
    for (const e of entries) {
      if (e.mtime >= cutoff && total <= MAX_DIR_BYTES) break
      fs.rmSync(path.join(logsDir, e.name), { force: true })
      total -= e.size
    }
  } catch { /* best effort */ }
}

module.exports = { init }

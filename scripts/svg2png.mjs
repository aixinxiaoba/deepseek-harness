#!/usr/bin/env node
/**
 * svg2png.mjs — rasterize an SVG to PNG with the best engine on hand.
 *
 * Zero-dependency. Layered backends (first usable wins):
 *   1. Headless Chromium Edge (ships with Windows 11 — the industry rendering
 *      baseline; zero install, zero network). Output scaled `scale`× via
 *      --force-device-scale-factor for crisp HiDPI results.
 *   2. @resvg/resvg-js (Rust resvg, no browser, deterministic) if importable —
 *      install it alongside this script with `npm i @resvg/resvg-js` to use.
 *
 * Usage:
 *   node svg2png.mjs <input.svg> [output.png] [scale]
 *
 * Output defaults to `<cwd>/.tmp-svg/<input-basename>.png` — keeping writes out
 * of the source folder when that folder is outside the writable workspace.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const [inputArg, outputArg, scaleArg] = process.argv.slice(2)
if (!inputArg) {
  console.error('usage: node svg2png.mjs <input.svg> [output.png] [scale]')
  process.exit(2)
}
const scale = scaleArg !== undefined ? Number(scaleArg) : 2
if (!Number.isFinite(scale) || scale <= 0) {
  console.error(`invalid scale: ${scaleArg}`)
  process.exit(2)
}

/** Parse intrinsic width/height from the leading <svg> tag: width/height, else viewBox. */
function intrinsicSize(svgText) {
  const svgTag = svgText.match(/<svg[^>]*>/i)?.[0] ?? ''
  const attr = (name) => svgTag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1]
  for (const name of ['width', 'height']) {
    const raw = attr(name)
    if (raw === undefined) continue
    const n = Number(raw.replace(/px$/i, '').trim())
    if (Number.isFinite(n) && n > 0) return { width: n, height: n }
  }
  const vb = attr('viewBox')?.split(/[\s,]+/).map(Number)
  if (vb && vb.length >= 4 && Number.isFinite(vb[2]) && vb[2] > 0 && Number.isFinite(vb[3]) && vb[3] > 0) {
    return { width: vb[2], height: vb[3] }
  }
  return { width: 1024, height: 1024 }
}

/** PNG pixel dimensions from the IHDR chunk (width at byte 16, height at 20). */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function findEdge() {
  if (process.env.EDGE_PATH && statSync(process.env.EDGE_PATH, { throwIfNoEntry: false })) return process.env.EDGE_PATH
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  return candidates.find((p) => statSync(p, { throwIfNoEntry: false })) ?? null
}

const input = resolve(inputArg)
const svgText = readFileSync(input, 'utf8')
const { width: w, height: h } = intrinsicSize(svgText)
const out = outputArg
  ? resolve(outputArg)
  : join(process.cwd(), '.tmp-svg', `${basename(input, '.svg')}.png`)
mkdirSync(dirname(out), { recursive: true })

let backend = null

// Backend 2: resvg-js (only when installed alongside).
try {
  const { Resvg } = await import('@resvg/resvg-js')
  const resvg = new Resvg(svgText, { fitTo: { mode: 'width', value: Math.round(w * scale) }, background: '#ffffff' })
  writeFileSync(out, resvg.render().asPng())
  backend = 'resvg-js'
} catch {
  backend = null
}

// Backend 1: headless Chromium Edge.
if (backend === null) {
  const edge = findEdge()
  if (!edge) {
    console.error('no renderer available: @resvg/resvg-js not installed and Edge not found')
    process.exit(1)
  }
  const url = pathToFileURL(input).href
  const profileDir = join(dirname(out), '.edge-prof')
  const baseFlags = [
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    `--window-size=${Math.round(w)},${Math.round(h)}`,
    `--force-device-scale-factor=${scale}`,
    '--default-background-color=ffffffff',
    '--virtual-time-budget=1500',
    `--screenshot=${out}`,
    url,
  ]
  // Edge 147 prefers --headless=new; older builds want plain --headless.
  let result = null
  for (const headless of ['--headless=new', '--headless']) {
    rmSync(profileDir, { recursive: true, force: true })
    result = spawnSync(edge, [headless, ...baseFlags], { encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'] })
    if (statSync(out, { throwIfNoEntry: false })) { backend = 'edge-headless'; break }
  }
  if (backend === null) {
    console.error(`Edge headless produced no screenshot.\nstderr: ${result?.stderr ?? '(none)'}`)
    process.exit(1)
  }
}

const size = pngSize(readFileSync(out))
console.log(`ok: ${out}  (${size?.width ?? '?'}x${size?.height ?? '?'}, ${backend}, scale ${scale}x)`)

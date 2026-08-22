#!/usr/bin/env node
/**
 * pngprobe.mjs — sample RGBA pixels from a PNG without any dependency.
 *
 * Reads IHDR + IDAT, inflates with node:zlib, applies the PNG filter
 * reconstruction (None/Sub/Up/Average/Paeth), then prints the pixel at each
 * (x, y) argument. Used to verify rasterized output when no vision channel is
 * available.
 *
 * Usage: node pngprobe.mjs <file.png> <x> <y> [<x> <y> ...]
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const [file, ...coords] = process.argv.slice(2)
if (!file || coords.length === 0 || coords.length % 2 !== 0) {
  console.error('usage: node pngprobe.mjs <file.png> <x> <y> [<x> <y> ...]')
  process.exit(2)
}
const points = []
for (let i = 0; i < coords.length; i += 2) points.push({ x: Number(coords[i]), y: Number(coords[i + 1]) })

const buf = readFileSync(file)
if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')

// Parse chunks.
let offset = 8
const idatParts = []
let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
while (offset < buf.length) {
  const length = buf.readUInt32BE(offset)
  const type = buf.toString('ascii', offset + 4, offset + 8)
  const data = buf.subarray(offset + 8, offset + 8 + length)
  if (type === 'IHDR') {
    width = data.readUInt32BE(0); height = data.readUInt32BE(4)
    bitDepth = data[8]; colorType = data[9]; interlace = data[12]
  } else if (type === 'IDAT') {
    idatParts.push(data)
  }
  offset += 12 + length
}
if (interlace !== 0) throw new Error('interlaced PNG not supported')
const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null
if (channels === null || bitDepth !== 8) throw new Error(`unsupported colorType/bitDepth: ${colorType}/${bitDepth}`)

// Reconstruct scanlines (all rows materialized so 'up' references resolve).
const raw = inflateSync(Buffer.concat(idatParts))
const stride = width * channels
const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}
const rows = []
let pos = 0
for (let y = 0; y < height; y++) {
  const filter = raw[pos]; pos++
  const row = new Uint8Array(stride)
  for (let i = 0; i < stride; i++) {
    const val = raw[pos + i]
    const left = i >= channels ? row[i - channels] : 0
    const up = y > 0 ? rows[y - 1][i] : 0
    const upLeft = y > 0 && i >= channels ? rows[y - 1][i - channels] : 0
    let recon
    switch (filter) {
      case 0: recon = val; break
      case 1: recon = val + left; break
      case 2: recon = val + up; break
      case 3: recon = val + ((left + up) >> 1); break
      case 4: recon = val + paeth(left, up, upLeft); break
      default: throw new Error(`bad filter ${filter}`)
    }
    row[i] = recon & 0xff
  }
  rows.push(row)
  pos += stride
}

const pixelAt = (x, y) => {
  const row = rows[y]
  const idx = x * channels
  const r = row[idx], g = row[idx + 1], b = row[idx + 2]
  const a = channels === 4 ? row[idx + 3] : 255
  return { r, g, b, a }
}

const hex = (n) => n.toString(16).padStart(2, '0')
console.log(`${file}  ${width}x${height}`)
for (const { x, y } of points) {
  const c = pixelAt(x, y)
  console.log(`  (${x}, ${y})  #${hex(c.r)}${hex(c.g)}${hex(c.b)}  rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`)
}

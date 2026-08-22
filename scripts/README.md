# `scripts/` SVG & pixel helpers

English | [中文](README.zh.md)

Utilities for turning SVGs into viewable PNGs and verifying rasterized output
in an environment with no vision channel.

- [svg2png.mjs](./svg2png.mjs) — rasterize an SVG to PNG.
- [pngprobe.mjs](./pngprobe.mjs) — sample PNG pixels without dependencies.

## svg2png.mjs

Claude Code's Read tool accepts only raster images (PNG/JPEG/WebP/GIF). SVG is
vector XML, so it cannot be previewed directly. `svg2png.mjs` rasterizes one SVG
with the best engine available on the machine:

1. **Headless Chromium Edge** (primary) — Windows 11 ships Edge, whose engine is
   the industry rendering baseline. Zero install, zero network. Output is scaled
   `scale`× for crisp HiDPI results.
2. **`@resvg/resvg-js`** (optional) — the Rust `resvg` engine; no browser,
   deterministic output. Install it next to the script (`npm i @resvg/resvg-js`)
   and it is used automatically.

### Usage

```sh
node scripts/svg2png.mjs <input.svg> [output.png] [scale]
```

- `input.svg` — the source SVG (any path; reads are unrestricted).
- `output.png` — destination. Defaults to `<cwd>/.tmp-svg/<input-basename>.png`
  so writes never land in the source folder when it is outside the writable
  workspace (the sandbox only allows writes inside the workspace).
- `scale` — pixel multiplier, default `2`.

Set `EDGE_PATH` to override the Edge binary location.

### Example

```sh
node scripts/svg2png.mjs "D:\My Documents\桌面\temp\kitten.svg"
# ok: D:\work\deepseek-harness\.tmp-svg\kitten.png (1200x1200, edge-headless, scale 2x)
```

## pngprobe.mjs

Verifies a rendered PNG without a vision channel: decodes the file (zero-
dependency `node:zlib` inflate plus PNG filter reconstruction) and prints the
RGBA value at each requested point.

### Usage

```sh
node scripts/pngprobe.mjs <file.png> <x> <y> [<x> <y> ...]
```

### Example

```sh
node scripts/pngprobe.mjs .tmp-svg/kitten.png 504 440 600 540
# (504, 440)  #0d1b3d  rgba(13, 27, 61, 255)
# (600, 540)  #ff8a8a  rgba(255, 138, 138, 255)
```

Both scripts run on the repository's bundled Node and have no dependencies.

# `scripts/` SVG 与像素工具

[English](README.md) | 中文

把 SVG 变成可看的 PNG、并在无视觉通道的环境里验证栅格化输出的实用工具。

- [svg2png.mjs](./svg2png.mjs) —— 把 SVG 栅格化成 PNG。
- [pngprobe.mjs](./pngprobe.mjs) —— 零依赖采样 PNG 像素。

## svg2png.mjs

Claude Code 的 Read 工具只接受位图（PNG/JPEG/WebP/GIF）。SVG 是矢量 XML，无法直接预览。`svg2png.mjs` 用机器上最好的可用引擎把单个 SVG 栅格化：

1. **无头 Chromium Edge**（首选）——Windows 11 自带 Edge，其渲染引擎就是行业渲染基准。零安装、零网络。输出按 `scale` 倍缩放，HiDPI 清晰。
2. **`@resvg/resvg-js`**（可选）——Rust `resvg` 引擎；无浏览器、确定性输出。在脚本旁安装（`npm i @resvg/resvg-js`）后自动使用。

### 用法

```sh
node scripts/svg2png.mjs <input.svg> [output.png] [scale]
```

- `input.svg` —— 源 SVG（任意路径；读取不受限）。
- `output.png` —— 输出路径。默认 `<cwd>/.tmp-svg/<输入文件名>.png`，当源目录在工作区之外时，写操作不会落到源目录（沙箱只允许写工作区）。
- `scale` —— 像素倍数，默认 `2`。

可用 `EDGE_PATH` 覆盖 Edge 可执行文件路径。

### 示例

```sh
node scripts/svg2png.mjs "D:\My Documents\桌面\temp\kitten.svg"
# ok: D:\work\deepseek-harness\.tmp-svg\kitten.png (1200x1200, edge-headless, scale 2x)
```

## pngprobe.mjs

在无视觉通道时验证渲染出的 PNG：解码文件（零依赖 `node:zlib` 解压 + PNG 滤波还原），打印每个请求点的 RGBA 值。

### 用法

```sh
node scripts/pngprobe.mjs <file.png> <x> <y> [<x> <y> ...]
```

### 示例

```sh
node scripts/pngprobe.mjs .tmp-svg/kitten.png 504 440 600 540
# (504, 440)  #0d1b3d  rgba(13, 27, 61, 255)
# (600, 540)  #ff8a8a  rgba(255, 138, 138, 255)
```

两个脚本都运行在仓库自带的 Node 上，零依赖。

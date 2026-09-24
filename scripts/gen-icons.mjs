/**
 * 生成 Tauri 应用图标（32x32 / 128x128 / 256x256 PNG + Windows icon.ico）。
 * 纯 Node 实现 PNG 编码（zlib），无第三方依赖。
 * 用法：node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'src-tauri', 'icons')
mkdirSync(outDir, { recursive: true })

/* ── PNG 编码 ──────────────────────────────────────── */
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function encodeIco(pngBuf, size) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // count
  const entry = Buffer.alloc(16)
  entry[0] = size >= 256 ? 0 : size
  entry[1] = size >= 256 ? 0 : size
  entry[2] = 0 // 调色板
  entry[3] = 0 // reserved
  entry.writeUInt32LE(pngBuf.length, 4)
  entry.writeUInt32LE(22, 8) // offset: 6 + 16
  return Buffer.concat([header, entry, pngBuf])
}

/* ── 绘制：深色圆角方 + 三条「文字行」+ 强调色光标 ──── */
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4)
  const BG = [22, 25, 32]
  const TEXT = [233, 236, 243]
  const ACCENT = [99, 132, 255]
  const r = size * 0.22
  const set = (x, y, c) => {
    const i = (y * size + x) * 4
    buf[i] = c[0]
    buf[i + 1] = c[1]
    buf[i + 2] = c[2]
    buf[i + 3] = 255
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(x, size - 1 - x)
      const cy = Math.min(y, size - 1 - y)
      if (cx < r && cy < r) {
        const dx = r - cx - 0.5
        const dy = r - cy - 0.5
        if (dx * dx + dy * dy > r * r) {
          buf[(y * size + x) * 4 + 3] = 0 // 圆角外透明
          continue
        }
      }
      set(x, y, BG)
    }
  }
  const pad = size * 0.24
  const lineH = Math.max(1, Math.round(size * 0.075))
  const gap = Math.max(1, Math.round(size * 0.095))
  const contentW = size - pad * 2
  const lines = [
    [0.62, TEXT],
    [0.44, TEXT],
    [0.08, ACCENT],
  ]
  let ly = pad
  for (const [frac, color] of lines) {
    const w = Math.max(lineH, Math.round(contentW * frac))
    for (let dy = 0; dy < lineH; dy++) {
      for (let dx = 0; dx < w; dx++) set(Math.floor(pad + dx), Math.floor(ly + dy), color)
    }
    ly += lineH + gap
  }
  return buf
}

const files = [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
]
for (const [name, size] of files) {
  writeFileSync(join(outDir, name), encodePng(size, size, drawIcon(size)))
}
writeFileSync(
  join(outDir, 'icon.ico'),
  encodeIco(encodePng(256, 256, drawIcon(256)), 256)
)
console.log('icons written to', outDir)

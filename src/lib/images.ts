/**
 * 图片：文稿里的图片就是内容只有一行 `![图注](路径)` 的段落。
 *
 * 这样存储、Markdown 导入导出、版本历史、建议与对照、同步比对、agent 定位都不用特殊处理，
 * 导出的 Markdown 也是标准写法。路径相对于工程文件所在目录，通常是旁边的 `稿.assets/xxx.png`；
 * 也可以是 http(s) 网址。
 */

export interface ImageRef {
  caption: string
  src: string
}

// ![图注](路径) 或 ![图注](<带空格的路径>)，可带 "title"
const IMAGE_LINE = /^!\[((?:[^\]\\\n]|\\.)*)\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+"[^"\n]*")?\s*\)$/

export function parseImage(text: string): ImageRef | null {
  const m = IMAGE_LINE.exec(text.trim())
  if (!m) return null
  return { caption: m[1].replace(/\\([\\\]\[])/g, '$1'), src: (m[2] ?? m[3]).trim() }
}

export function isImageText(text: string): boolean {
  return parseImage(text) !== null
}

export function imageLine(caption: string, src: string): string {
  const cap = caption.replace(/\s*\n\s*/g, ' ').trim().replace(/([\\\]\[])/g, '\\$1')
  const path = /[\s()<>]/.test(src) ? `<${src}>` : src
  return `![${cap}](${path})`
}

export function isRemote(src: string): boolean {
  return /^(https?:|data:)/i.test(src)
}

/**
 * AI 改写一整节时可能把图片行弄丢：把原文里有、结果里没有的图片放回原来的相对位置。
 * 段落之间以空行分隔。
 */
export function preserveImages(original: string, output: string): string {
  const before = original.split(/\n{2,}/)
  const after = output.split(/\n{2,}/)
  const kept = new Set(after.map((p) => p.trim()))
  let changed = false
  before.forEach((p, i) => {
    if (!isImageText(p) || kept.has(p.trim())) return
    // 按在原文中的位置比例放回
    const at = Math.min(after.length, Math.round((i / Math.max(1, before.length)) * after.length))
    after.splice(at, 0, p.trim())
    changed = true
  })
  return changed ? after.join('\n\n') : output
}

/* ── 文件 ──────────────────────────────────────────── */

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

export const IMAGE_EXTS = Object.keys(MIME)

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name)
  return m ? m[1].toLowerCase() : ''
}

export function isImageName(name: string): boolean {
  return extOf(name) in MIME
}

export function mimeOf(name: string): string {
  return MIME[extOf(name)] ?? 'application/octet-stream'
}

export function extFromMime(mime: string): string {
  const ext = Object.entries(MIME).find(([, m]) => m === mime.toLowerCase())?.[0]
  return ext === 'jpeg' ? 'jpg' : ext ?? 'png'
}

/** 按内容取名：同一张图只存一份，名字稳定 */
export async function contentName(bytes: Uint8Array, ext: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  const hex = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex}.${ext === 'jpeg' ? 'jpg' : ext || 'png'}`
}

/** 按文件头认出图片格式（扩展名不可靠或没有时用）；认不出返回 null */
export function sniffExt(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'webp'
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  const head = new TextDecoder().decode(b.slice(0, 256)).trimStart()
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg'
  return null
}

/**
 * 给操作结果里的每张图片（形如 {type: 'image', src}）补上信息：绝对路径、尺寸、是否存在……
 * 由命令行 / App 各自提供 info（它们知道图片放在哪）。
 */
export async function annotateImages(
  value: unknown,
  info: (src: string) => Promise<Record<string, unknown> | null>
): Promise<void> {
  if (Array.isArray(value)) {
    for (const v of value) await annotateImages(v, info)
  } else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (o.type === 'image' && typeof o.src === 'string') Object.assign(o, (await info(o.src)) ?? {})
    else for (const v of Object.values(o)) await annotateImages(v, info)
  }
}

/** 从文件头读出宽高（PNG / JPEG / GIF / WebP）；认不出返回 null */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1]
  const u16le = (i: number) => b[i] | (b[i + 1] << 8)
  const u32be = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32be(16), height: u32be(20) }
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: u16le(6), height: u16le(8) }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]
      const len = u16be(i + 2)
      // SOF0–SOF15（除去 DHT / JPG / DAC）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(i + 7), height: u16be(i + 5) }
      }
      i += 2 + len
    }
    return null
  }
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) }
    if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  return null
}

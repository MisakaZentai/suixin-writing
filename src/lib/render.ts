/**
 * 文稿 → HTML：导出、排版预览、发布共用同一套渲染。
 *
 * - 段落按 Markdown 渲染（加粗、斜体、链接、行内代码、列表、引用、代码块、表格）；
 *   段内换行保留为换行；原始 HTML 一律当文字显示，不执行；
 * - 单独一段的 `![图注](路径)` 渲染成 图 + 图注；
 * - 标题按层级输出，文稿标题可选地放在最前面。
 */
import { Marked, type Tokens } from 'marked'
import { isImageText, parseImage } from './images'

export interface RenderBlock {
  type: 'heading' | 'paragraph'
  level?: number
  text: string
}

export interface RenderDoc {
  title: string
  blocks: RenderBlock[]
}

export type RenderStyle = 'reading' | 'zhihu'

/** 发布用的块序列：HTML 片段与图片交替出现 */
export type RenderPart =
  | { kind: 'html'; html: string }
  | { kind: 'image'; src: string; caption: string; url: string | null }

export interface RenderOptions {
  /** 图片的显示地址（data: / file: / 网址）；null 表示找不到 */
  image: (src: string) => Promise<string | null>
  style?: RenderStyle
  /** 把文稿标题作为一级标题放在最前面（默认是） */
  includeTitle?: boolean
  /** 页面宽度（像素），预览截图时用 */
  width?: number
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const SAFE_URL = /^(https?:|mailto:|#|\/|\.{0,2}\/|[^:]*$)/i

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // 原始 HTML 当文字显示：正文可能来自 agent，不能在导出的页面里执行
    html(token: Tokens.HTML | Tokens.Tag) {
      const text = escapeHtml(token.text)
      return 'block' in token && token.block ? `<p>${text.trim()}</p>\n` : text
    },
    link({ href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens)
      if (!SAFE_URL.test(href)) return inner
      return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${inner}</a>`
    },
    // 段落中间夹着的图片：只留图注文字（整段的图片另行处理）
    image({ text }: Tokens.Image) {
      return text ? `[图：${escapeHtml(text)}]` : ''
    },
  },
})

export function renderMarkdown(text: string): string {
  return md.parse(text, { async: false }) as string
}

export function renderInline(text: string): string {
  return md.parseInline(text, { async: false }) as string
}

function figureHtml(caption: string, url: string | null, src: string): string {
  const cap = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''
  if (!url) return `<figure class="missing"><div class="missing-box">图片缺失：${escapeHtml(src)}</div>${cap}</figure>`
  return `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(caption)}">${cap}</figure>`
}

/** 按块渲染：连续的文字合成一个 HTML 片段，图片单独成一项 */
export async function renderParts(doc: RenderDoc, opts: RenderOptions): Promise<RenderPart[]> {
  const parts: RenderPart[] = []
  let html = ''
  const flush = () => {
    if (html) parts.push({ kind: 'html', html })
    html = ''
  }
  if (opts.includeTitle !== false && doc.title.trim()) html += `<h1>${renderInline(doc.title.trim())}</h1>\n`
  for (const b of doc.blocks) {
    if (!b.text.trim()) continue
    if (b.type === 'heading') {
      const level = Math.min(6, Math.max(1, b.level ?? 2))
      html += `<h${level}>${renderInline(b.text)}</h${level}>\n`
      continue
    }
    if (isImageText(b.text)) {
      const img = parseImage(b.text)!
      flush()
      parts.push({ kind: 'image', src: img.src, caption: img.caption, url: await opts.image(img.src).catch(() => null) })
      continue
    }
    html += renderMarkdown(b.text)
  }
  flush()
  return parts
}

/** 正文 HTML（不含外壳） */
export async function renderBody(doc: RenderDoc, opts: RenderOptions): Promise<string> {
  const parts = await renderParts(doc, opts)
  return parts.map((p) => (p.kind === 'html' ? p.html : figureHtml(p.caption, p.url, p.src))).join('\n')
}

/** 完整的 HTML 页面（自带样式；图片地址由 opts.image 决定，给 data: 即是自包含的单文件） */
export async function renderPage(doc: RenderDoc, opts: RenderOptions): Promise<string> {
  const body = await renderBody(doc, opts)
  const style = opts.style ?? 'reading'
  const width = opts.width ?? (style === 'zhihu' ? 690 : 720)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="随心写作">
<title>${escapeHtml(doc.title)}</title>
<style>${PAGE_CSS[style].replace(/--width/g, `${width}px`)}</style>
</head>
<body>
<article>
${body}
</article>
</body>
</html>
`
}

const COMMON_CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#fff}
article{max-width:--width;margin:0 auto;padding:40px 24px 64px}
img{max-width:100%;height:auto}
figure{margin:1.4em 0;text-align:center}
figure img{display:block;margin:0 auto;border-radius:4px}
figcaption{margin-top:.6em;font-size:14px;color:#8590a6;line-height:1.6}
figure.missing .missing-box{padding:28px 16px;border:1px dashed #c4c7ce;border-radius:4px;color:#8590a6;font-size:14px;word-break:break-all}
blockquote{margin:1em 0;padding:0 1em;border-left:3px solid #d3d6db;color:#646464}
pre{overflow:auto;padding:12px 14px;border-radius:4px;background:#f6f6f6;font-size:14px;line-height:1.6}
code{font-family:Menlo,Consolas,"Courier New",monospace;font-size:.9em}
:not(pre)>code{padding:1px 4px;border-radius:3px;background:#f6f6f6}
table{border-collapse:collapse;margin:1em 0}
th,td{border:1px solid #e0e0e0;padding:6px 10px}
hr{border:none;border-top:1px solid #e0e0e0;margin:2em 0}
a{color:#175199;text-decoration:none;border-bottom:1px solid rgba(23,81,153,.3)}
`

const PAGE_CSS: Record<RenderStyle, string> = {
  // 与 App 的阅读排版一致：宋体正文、疏朗行距
  reading: `${COMMON_CSS}
body{color:#1d1d1f;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",SimSun,serif;font-size:17px;line-height:1.85}
h1{font-size:28px;line-height:1.4;margin:0 0 1.2em}
h2{font-size:22px;margin:1.8em 0 .8em}
h3{font-size:19px;margin:1.6em 0 .7em}
h4,h5,h6{font-size:17px;margin:1.4em 0 .6em}
p{margin:0 0 1em}
`,
  // 接近知乎专栏文章的排版：用来预览"发出去大概的样子"
  zhihu: `${COMMON_CSS}
body{color:#121212;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue","PingFang SC","Microsoft YaHei","Source Han Sans SC","Noto Sans CJK SC",sans-serif;font-size:15px;line-height:1.67}
h1{font-size:24px;line-height:1.4;margin:0 0 24px;font-weight:600}
h2{font-size:20px;margin:28px 0 14px;font-weight:600}
h3{font-size:17px;margin:22px 0 12px;font-weight:600}
h4,h5,h6{font-size:15px;margin:18px 0 10px;font-weight:600}
p{margin:1.4em 0}
`,
}

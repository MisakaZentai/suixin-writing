/**
 * 命令行的渲染与导出：HTML（自包含）、Markdown（连同图片文件夹）、PDF、分页 PNG。
 * 文稿从 App（在线且打开着这篇时）或工程文件读取，图片同理。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentError } from '../src/agent/errors'
import { imageLine, isRemote, parseImage } from '../src/lib/images'
import { renderPage, renderParts, type RenderBlock, type RenderDoc, type RenderPart, type RenderStyle } from '../src/lib/render'
import { toMarkdown } from '../src/lib/markdown'
import type { BridgeClient } from './bridge'
import { operate } from './files'
import { readImage } from './images'
import { htmlToPdf, htmlToPngPages, requireBrowser } from './browser'
import { publishScript, splitParts, zhihuHtml, type PublishPart } from '../src/lib/zhihu'

type Env = Record<string, string | undefined>

export interface LoadedDoc extends RenderDoc {
  file: string | null
  /** 读图片内容（本地图片；网址会下载） */
  image: (src: string) => Promise<{ bytes: Uint8Array; mime: string } | null>
}

interface BlockView {
  id: string
  type: 'heading' | 'paragraph' | 'image'
  level?: number
  text: string
}

/** 读出整篇（或一节）：分页读完，块转成渲染用的形式 */
export async function loadForRender(file: string | null, bridge: BridgeClient | null, section?: string): Promise<LoadedDoc> {
  const opts = { author: 'Agent', bridge }
  const info = (await operate(file, [{ op: 'info' }], opts)) as { results: [{ title: string }] }
  const blocks: RenderBlock[] = []
  let from: string | undefined
  for (;;) {
    const call: Record<string, unknown> = { op: 'read', limit: 500 }
    if (section) call.section = section
    if (from) call.from = from
    const r = (await operate(file, [call as { op: string }], opts)) as { results: [{ blocks: BlockView[]; next?: string }] }
    for (const b of r.results[0].blocks) {
      blocks.push(b.type === 'heading' ? { type: 'heading', level: b.level, text: b.text } : { type: 'paragraph', text: b.text })
    }
    from = r.results[0].next
    if (!from) break
  }
  return {
    file,
    title: info.results[0].title,
    blocks,
    image: async (src) => {
      const img = await readImage(file, { src }, bridge).catch(() => null)
      return img ? { bytes: img.bytes, mime: img.mime } : null
    },
  }
}

export function dataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/** 图片内嵌成 data: URI 的 HTML 页面（单文件，可以直接发给别人） */
export async function selfContainedHtml(doc: LoadedDoc, style: RenderStyle, width?: number): Promise<string> {
  const html = await renderPage(doc, {
    style,
    width,
    image: async (src) => {
      const img = await doc.image(src)
      return img ? dataUri(img.bytes, img.mime) : null
    },
  })
  return html
}

/** 发布用的块序列（图片附上内容） */
export async function publishParts(doc: LoadedDoc): Promise<(RenderPart & { bytes?: Uint8Array; mime?: string })[]> {
  const bytes = new Map<string, { bytes: Uint8Array; mime: string }>()
  const parts = await renderParts(doc, {
    includeTitle: false,
    image: async (src) => {
      const img = await doc.image(src)
      if (!img) return null
      bytes.set(src, img)
      return src
    },
  })
  return parts.map((p) => (p.kind === 'image' && bytes.has(p.src) ? { ...p, ...bytes.get(p.src)! } : p))
}

/**
 * Markdown 连同图片：图片复制到输出文件旁边的 `<名字>.assets/`，文中路径随之改写。
 * 网址图片保持原样。
 */
export async function exportMarkdownWithImages(doc: LoadedDoc, out: string): Promise<{ file: string; images: number; missing: string[] }> {
  const stem = path.basename(out).replace(/\.(md|markdown)$/i, '')
  const assetsDir = `${stem}.assets`
  const missing: string[] = []
  let images = 0
  const blocks: RenderBlock[] = []
  for (const b of doc.blocks) {
    const img = b.type === 'paragraph' ? parseImage(b.text) : null
    if (!img || isRemote(img.src)) {
      blocks.push(b)
      continue
    }
    const data = await doc.image(img.src)
    if (!data) {
      missing.push(img.src)
      blocks.push(b)
      continue
    }
    const name = img.src.split('/').pop()!
    await fs.mkdir(path.join(path.dirname(out), assetsDir), { recursive: true })
    await fs.writeFile(path.join(path.dirname(out), assetsDir, name), data.bytes)
    blocks.push({ type: 'paragraph', text: imageLine(img.caption, `${assetsDir}/${name}`) })
    images++
  }
  const md = toMarkdown(
    { title: doc.title },
    blocks.map((b, i) =>
      b.type === 'heading'
        ? { id: `h${i}`, type: 'heading' as const, level: b.level ?? 2, text: b.text, versions: [] }
        : { id: `p${i}`, type: 'paragraph' as const, text: b.text, versions: [] }
    )
  )
  await fs.writeFile(out, md, 'utf8')
  return { file: out, images, missing }
}

export async function exportPdf(doc: LoadedDoc, out: string, style: RenderStyle, env: Env): Promise<{ file: string }> {
  const browser = requireBrowser(env)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'suixin-render-'))
  try {
    const html = path.join(tmp, 'doc.html')
    await fs.writeFile(html, await selfContainedHtml(doc, style), 'utf8')
    await htmlToPdf(browser, html, out)
    return { file: out }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

export interface RenderPngOptions {
  style: RenderStyle
  width: number
  pageHeight: number
  maxPages: number
  firstPage?: number
}

/** 排版截图：按页输出 PNG，供多模态模型检查版面 */
export async function renderPngPages(doc: LoadedDoc, outDir: string, opts: RenderPngOptions, env: Env) {
  const browser = requireBrowser(env)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'suixin-render-'))
  try {
    const html = path.join(tmp, 'doc.html')
    await fs.writeFile(html, await selfContainedHtml(doc, opts.style, opts.width - 48), 'utf8')
    return await htmlToPngPages(browser, html, outDir, { ...opts, prefix: 'page' })
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 知乎发布包：publish.js（图片内嵌；太大时拆成 publish-1.js、publish-2.js…）、
 * 预览用的 content.html、images/ 与说明。
 */
export async function exportZhihu(doc: LoadedDoc, outDir: string, maxScriptBytes = 4 * 1024 * 1024) {
  const parts = await publishParts(doc)
  const missing = parts.filter((p) => p.kind === 'image' && !p.bytes).map((p) => (p as { src: string }).src)
  const publish: PublishPart[] = []
  await fs.mkdir(path.join(outDir, 'images'), { recursive: true })
  for (const p of parts) {
    if (p.kind === 'html') publish.push({ kind: 'html', html: zhihuHtml(p.html) })
    else if (p.bytes) {
      const name = p.src.split('/').pop()!
      await fs.writeFile(path.join(outDir, 'images', name), p.bytes)
      publish.push({ kind: 'image', name, mime: p.mime!, base64: Buffer.from(p.bytes).toString('base64'), caption: p.caption })
    }
  }
  const chunks = splitParts(publish, maxScriptBytes)
  const scripts: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const name = chunks.length === 1 ? 'publish.js' : `publish-${i + 1}.js`
    await fs.writeFile(path.join(outDir, name), publishScript(doc.title, chunks[i], { chunk: i + 1, chunks: chunks.length }), 'utf8')
    scripts.push(path.join(outDir, name))
  }
  // 预览：图片指向 images/，便于人工核对
  const preview = await renderPage(doc, { style: 'zhihu', image: async (src) => `images/${src.split('/').pop()}` })
  await fs.writeFile(path.join(outDir, 'content.html'), preview, 'utf8')
  const images = publish.filter((p) => p.kind === 'image').length
  await fs.writeFile(path.join(outDir, '说明.md'), zhihuReadme(doc.title, scripts.map((s) => path.basename(s)), images), 'utf8')
  return { dir: outDir, title: doc.title, scripts, parts: publish.length, images, missing, preview: path.join(outDir, 'content.html') }
}

function zhihuReadme(title: string, scripts: string[], images: number): string {
  return `# 知乎发布包：${title}

共 ${images} 张图片。脚本只把内容填进知乎草稿，不会点"发布"——请作者检查后自己发。

## 让 agent 自动填（浏览器能执行脚本时）

1. 在已登录知乎的浏览器里打开 https://zhuanlan.zhihu.com/write ，等编辑器加载完。
2. 在该页面依次执行：${scripts.map((s) => `\`${s}\``).join(' → ')}（整个文件内容作为脚本执行）。
3. 每段的返回值（也存在 window.__suixinPublish）里：
   - ok 为 true 表示这一段都放进去了；
   - failed 里是没传完的图片；把 window.__suixinResumeFrom 设为 resumeFrom 后重新执行同一段即可从那里继续；
   - captions 少于图片数时，请在知乎里给相应图片补上图注（见 content.html）。
4. 用截图核对版面，把结果告诉作者，由作者点"发布"。

## 手动发（或用 computer use）

在随心写作里打开「文件 → 发布到知乎…」，逐段"复制"，到知乎编辑器里粘贴即可；图片会由知乎自动上传。

content.html 是按知乎样式渲染的预览，images/ 里是全部图片。
`
}

export function parseStyle(v: unknown): RenderStyle {
  if (v === undefined || v === 'reading') return 'reading'
  if (v === 'zhihu') return 'zhihu'
  throw new AgentError('INVALID_PARAMS', `没有样式 ${String(v)}`, '可用：reading（阅读排版）、zhihu（接近知乎文章）')
}


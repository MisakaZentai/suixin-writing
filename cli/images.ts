/**
 * 命令行 / MCP 的图片操作：插图、取图（给多模态模型看）。
 * App 开着且打开的正是这篇时交给 App 存取，否则直接读写工程文件旁边的 `<名字>.assets/`。
 * 命名规则与 App 相同（src/lib/assets.ts）：按内容取名，同一张图只存一份。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AgentError } from '../src/agent/errors'
import type { TargetSpec } from '../src/agent/target'
import { contentName, extOf, imageLine, imageSize, isImageName, isRemote, mimeOf, sniffExt } from '../src/lib/images'
import { BridgeOffline, offlineError, type BridgeClient } from './bridge'
import { assetFile, loadProject, operate, type OperateOptions } from './files'

const MAX_IMAGE_BYTES = 30 * 1024 * 1024

/* ── 文件模式 ─────────────────────────────────────── */

function stemOf(file: string): string {
  return path.basename(file).replace(/\.suixin\.json$/i, '').replace(/\.json$/i, '')
}

/** 存进工程文件旁边的资源文件夹，返回写进文稿的相对路径 */
export async function putAssetFile(file: string, bytes: Uint8Array, ext: string, dryRun = false): Promise<string> {
  const src = `${stemOf(file)}.assets/${await contentName(bytes, ext)}`
  if (dryRun) return src
  const abs = assetFile(file, src)
  const exists = await fs.access(abs).then(() => true, () => false)
  if (!exists) {
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, bytes)
  }
  return src
}

/* ── 图片来源：本地文件或网址 ───────────────────────── */

export async function loadImageSource(source: string, cwd: string): Promise<{ bytes: Uint8Array; ext: string }> {
  let bytes: Uint8Array
  if (/^https?:\/\//i.test(source)) {
    let res: Response
    try {
      res = await fetch(source, { signal: AbortSignal.timeout(30_000) })
    } catch (e) {
      throw new AgentError('IO', `下载图片失败：${(e as Error).message}`)
    }
    if (!res.ok) throw new AgentError('IO', `下载图片失败：HTTP ${res.status}`)
    bytes = new Uint8Array(await res.arrayBuffer())
  } else {
    const abs = path.resolve(cwd, source.replace(/^file:\/\/\/?/i, ''))
    try {
      bytes = new Uint8Array(await fs.readFile(abs))
    } catch {
      throw new AgentError('NOT_FOUND', `打不开图片 ${abs}`)
    }
  }
  if (bytes.length > MAX_IMAGE_BYTES) throw new AgentError('INVALID_PARAMS', '图片超过 30 MB')
  const ext = sniffExt(bytes) ?? (isImageName(source) ? extOf(source) : null)
  if (!ext) throw new AgentError('INVALID_PARAMS', '这不是能识别的图片（支持 PNG / JPEG / GIF / WebP / SVG / BMP）')
  return { bytes, ext }
}

/* ── 插图 ─────────────────────────────────────────── */

export interface AddImageOptions extends OperateOptions {
  /** 插在哪里："start" / "end" 或一个定位 */
  after: 'start' | 'end' | TargetSpec
  caption?: string
  why?: string
}

/**
 * 插一张图：先把图片存好，再以 insert 操作插入 `![图注](路径)`——
 * 默认成为待作者确认的建议（作者放弃时图片文件留着，不影响文稿）。
 */
export async function addImage(file: string | null, image: { bytes: Uint8Array; ext: string }, opts: AddImageOptions) {
  let src: string | null = null
  if (opts.bridge) {
    try {
      const r = (await opts.bridge.call('asset.put', {
        file,
        data: Buffer.from(image.bytes).toString('base64'),
        ext: image.ext,
        dryRun: !!opts.dryRun,
      })) as { handled: boolean; src?: string }
      if (r.handled) src = r.src!
    } catch (e) {
      if (!(e instanceof BridgeOffline)) throw e
    }
  }
  if (!src) {
    if (!file) throw offlineError()
    await loadProject(file) // 先确认工程文件能打开，再写图片
    src = await putAssetFile(file, image.bytes, image.ext, opts.dryRun)
  }
  const call = { op: 'insert', after: opts.after, text: imageLine(opts.caption ?? '', src), ...(opts.why ? { why: opts.why } : {}) }
  const result = (await operate(file, [call], opts)) as Record<string, unknown>
  return { ...result, image: { src, ...(imageSize(image.bytes) ?? {}), bytes: image.bytes.length } }
}

/* ── 取图 ─────────────────────────────────────────── */

export interface ImageData {
  src: string
  caption: string
  mime: string
  bytes: Uint8Array
  path: string | null
}

/** 按图片段落 id 或路径取出图片内容 */
export async function readImage(
  file: string | null,
  which: { block?: string; src?: string },
  bridge: BridgeClient | null
): Promise<ImageData> {
  // 先找到 src 与图注
  let src = which.src ?? null
  let caption = ''
  if (which.block) {
    const r = (await operate(file, [{ op: 'read', from: which.block, limit: 1 }], { author: 'Agent', bridge })) as {
      results: [{ blocks: { id: string; type: string; src?: string; caption?: string }[] }]
    }
    const b = r.results[0].blocks[0]
    if (!b || b.id !== which.block || b.type !== 'image') throw new AgentError('NOT_FOUND', `${which.block} 不是图片段落`, '用 read 找 type 为 image 的块')
    src = b.src!
    caption = b.caption ?? ''
  }
  if (!src) throw new AgentError('INVALID_PARAMS', '需要 block（图片段落 id）或 src')
  if (/^data:/i.test(src)) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(src)
    if (!m) throw new AgentError('INVALID_PARAMS', '无法解析的 data: 图片')
    return { src, caption, mime: m[1], bytes: Uint8Array.from(Buffer.from(decodeURIComponent(m[3]), m[2] ? 'base64' : 'utf8')), path: null }
  }
  if (isRemote(src)) {
    const { bytes, ext } = await loadImageSource(src, process.cwd())
    return { src, caption, mime: mimeOf(`x.${ext}`), bytes, path: null }
  }
  if (bridge) {
    try {
      const r = (await bridge.call('asset.read', { file, src })) as { handled: boolean; data?: string; path?: string | null }
      if (r.handled) return { src, caption, mime: mimeOf(src), bytes: Uint8Array.from(Buffer.from(r.data!, 'base64')), path: r.path ?? null }
    } catch (e) {
      if (!(e instanceof BridgeOffline)) throw e
    }
  }
  if (!file) throw offlineError()
  const abs = assetFile(file, src)
  const bytes = await fs.readFile(abs).catch(() => null)
  if (!bytes) throw new AgentError('NOT_FOUND', `图片文件不存在：${abs}`)
  return { src, caption, mime: mimeOf(src), bytes: new Uint8Array(bytes), path: abs }
}

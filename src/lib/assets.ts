/**
 * 文稿的图片资源。
 *
 * - 桌面版：放在工程文件旁边的 `<名字>.assets/` 文件夹（文稿库里的文稿是 `library/<id>.assets/`），
 *   文稿里记相对路径，如 `稿.assets/3f2a9c01d4e5b6a7.png`；
 * - 浏览器模式：存进 IndexedDB，路径写法相同。
 * 文件按内容命名，同一张图只存一份。
 */
import type { ProjectData } from '../types'
import { contentName, extOf, imageLine, isRemote, mimeOf, parseImage } from './images'
import { isTauri, readBinaryAt } from './platform'

export interface AssetCtx {
  docId: string
  /** 绑定的工程文件；null 表示只在文稿库里 */
  path: string | null
}

/** 工程文件名去掉后缀：稿.suixin.json → 稿 */
export function stemOf(ctx: AssetCtx): string {
  if (!ctx.path) return ctx.docId
  const name = ctx.path.split(/[\\/]/).pop() ?? ctx.docId
  return name.replace(/\.suixin\.json$/i, '').replace(/\.json$/i, '') || ctx.docId
}

export function assetsDirName(ctx: AssetCtx): string {
  return `${stemOf(ctx)}.assets`
}

interface Backend {
  write: (ctx: AssetCtx, src: string, bytes: Uint8Array) => Promise<void>
  read: (ctx: AssetCtx, src: string) => Promise<Uint8Array | null>
  /** 桌面版的绝对路径 */
  absolute: (ctx: AssetCtx, src: string) => Promise<string | null>
}

/* ── 桌面版：文件夹 ─────────────────────────────────── */

async function baseDir(ctx: AssetCtx): Promise<string> {
  const { appDataDir, dirname, join } = await import('@tauri-apps/api/path')
  return ctx.path ? dirname(ctx.path) : join(await appDataDir(), 'library')
}

const desktop: Backend = {
  async absolute(ctx, src) {
    const { join } = await import('@tauri-apps/api/path')
    return join(await baseDir(ctx), ...src.split('/'))
  },
  async write(ctx, src, bytes) {
    const { dirname } = await import('@tauri-apps/api/path')
    const { exists, mkdir, writeFile } = await import('@tauri-apps/plugin-fs')
    const file = (await desktop.absolute(ctx, src))!
    if (await exists(file)) return
    await mkdir(await dirname(file), { recursive: true }).catch(() => {})
    await writeFile(file, bytes)
  },
  async read(ctx, src) {
    const { exists, readFile } = await import('@tauri-apps/plugin-fs')
    const file = (await desktop.absolute(ctx, src))!
    if (!(await exists(file))) return null
    return readFile(file)
  },
}

/* ── 浏览器：IndexedDB ─────────────────────────────── */

let dbPromise: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('suixin-assets', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('files')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('无法打开本机图片库'))
  }))
}

const key = (ctx: AssetCtx, src: string) => `${ctx.docId}/${src}`

const browser: Backend = {
  async absolute() {
    return null
  },
  async write(ctx, src, bytes) {
    const tx = (await db()).transaction('files', 'readwrite')
    tx.objectStore('files').put(new Blob([bytes as Uint8Array<ArrayBuffer>]), key(ctx, src))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  },
  async read(ctx, src) {
    const tx = (await db()).transaction('files', 'readonly')
    const blob = await new Promise<Blob | undefined>((resolve, reject) => {
      const req = tx.objectStore('files').get(key(ctx, src))
      req.onsuccess = () => resolve(req.result as Blob | undefined)
      req.onerror = () => reject(req.error)
    })
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null
  },
}

const backend = (): Backend => (isTauri ? desktop : browser)

/**
 * 从文稿库删掉一篇文稿时，连同它的图片一起删（只删文稿库自己的 `<id>.assets/`；
 * 绑定了用户文件的文稿，图片在用户的文件夹里，不碰）。
 */
export async function removeLibraryAssets(docId: string): Promise<void> {
  if (isTauri) {
    const { exists, remove } = await import('@tauri-apps/plugin-fs')
    const dir = (await desktop.absolute({ docId, path: null }, `${docId}.assets`))!
    if (await exists(dir)) await remove(dir, { recursive: true })
    return
  }
  const store = (await db()).transaction('files', 'readwrite').objectStore('files')
  await new Promise<void>((resolve, reject) => {
    const req = store.delete(IDBKeyRange.bound(`${docId}/`, `${docId}/￿`))
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

/* ── 对外 ───────────────────────────────────────────── */

/** 存一张图，返回写进文稿的相对路径 */
export async function putAsset(ctx: AssetCtx, bytes: Uint8Array, ext: string): Promise<string> {
  const src = `${assetsDirName(ctx)}/${await contentName(bytes, ext)}`
  await backend().write(ctx, src, bytes)
  return src
}

export async function readAsset(ctx: AssetCtx, src: string): Promise<Uint8Array | null> {
  if (isRemote(src)) return null
  return backend()
    .read(ctx, src)
    .catch(() => null)
}

export async function assetPath(ctx: AssetCtx, src: string): Promise<string | null> {
  if (isRemote(src)) return null
  return backend().absolute(ctx, src)
}

const urls = new Map<string, string>()

/** 显示用的地址：网址原样，本地图片读出来转成 blob: 地址（按文件缓存）；找不到返回 null */
export async function assetUrl(ctx: AssetCtx, src: string): Promise<string | null> {
  if (isRemote(src)) return src
  const k = `${isTauri ? (await baseDir(ctx).catch(() => '')) : ctx.docId}|${src}`
  const hit = urls.get(k)
  if (hit) return hit
  const bytes = await readAsset(ctx, src)
  if (!bytes) return null
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeOf(src) }))
  urls.set(k, url)
  return url
}

/** 文稿里用到的本地图片（正文与待确认的建议里的） */
export function imageSrcs(data: ProjectData): string[] {
  const out = new Set<string>()
  const scan = (text: string) => {
    for (const line of text.split('\n')) {
      const img = parseImage(line)
      if (img && !isRemote(img.src)) out.add(img.src)
    }
  }
  data.blocks.forEach((b) => scan(b.text))
  data.suggestions.filter((s) => s.state === 'pending').forEach((s) => scan(s.proposed))
  return [...out]
}

/**
 * 改写图片引用（正文、历史版本、建议里的都改）。图片按内容命名，路径不会和别的文字撞上，
 * 所以直接在序列化后的文本里整体替换。
 */
export function rewriteImageSrcs(data: ProjectData, moved: Map<string, string>): ProjectData {
  let json = JSON.stringify(data)
  for (const [from, to] of moved) json = json.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1))
  return JSON.parse(json) as ProjectData
}

/**
 * 从 Markdown 文件导入：它引用的本地图片（相对路径、绝对路径或 file://）
 * 读进来存进新文稿的资源文件夹。找不到的保持原样，界面上会提示缺失。只用于桌面版。
 */
export async function adoptLocalImages(data: ProjectData, sourceFile: string, ctx: AssetCtx): Promise<number> {
  const { dirname, isAbsolute, join } = await import('@tauri-apps/api/path')
  const base = await dirname(sourceFile)
  let adopted = 0
  for (const b of data.blocks) {
    const img = b.type === 'paragraph' ? parseImage(b.text) : null
    if (!img || isRemote(img.src)) continue
    let rel = img.src.replace(/^file:\/\/\/?/i, '')
    try {
      rel = decodeURI(rel)
    } catch {
      /* 本来就没编码 */
    }
    const abs = (await isAbsolute(rel)) ? rel : await join(base, ...rel.split(/[\\/]/))
    const bytes = await readBinaryAt(abs).catch(() => null)
    if (!bytes) continue
    b.text = imageLine(img.caption, await putAsset(ctx, bytes, extOf(rel) || 'png'))
    b.versions = b.versions.map((v) => ({ ...v, text: b.text }))
    adopted++
  }
  return adopted
}

/**
 * 文稿换了位置（另存为、从文稿库存到文件）：把图片复制到新位置旁边，
 * 返回 旧路径 → 新路径 的对照，用来改写文稿里的引用。缺失的图片跳过。
 */
export async function copyAssets(from: AssetCtx, to: AssetCtx, srcs: string[]): Promise<Map<string, string>> {
  const moved = new Map<string, string>()
  const dir = assetsDirName(to)
  for (const src of new Set(srcs)) {
    if (isRemote(src)) continue
    const bytes = await readAsset(from, src)
    if (!bytes) continue
    const next = `${dir}/${src.split('/').pop()}`
    await backend().write(to, next, bytes)
    if (next !== src) moved.set(src, next)
  }
  return moved
}

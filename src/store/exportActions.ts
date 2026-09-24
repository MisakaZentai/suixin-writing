/**
 * 导出：HTML（单文件，图片内嵌）、Markdown（桌面版连同图片文件夹）。
 * 渲染与命令行共用 src/lib/render.ts，导出什么样，agent 预览到的就是什么样。
 */
import type { ProjectData } from '../types'
import { exportMarkdown, safeFileName } from '../lib/project'
import { imageLine, isRemote, mimeOf, parseImage } from '../lib/images'
import { readAsset } from '../lib/assets'
import { renderPage, type RenderDoc, type RenderStyle } from '../lib/render'
import { isTauri, pickSavePath, saveTextFile, writeBinaryAt, writeFileAt } from '../lib/platform'
import { useProjectStore } from './projectStore'
import { useUIStore } from './uiStore'
import { currentAssetCtx } from './imageActions'

function toast(kind: 'success' | 'error' | 'info', text: string) {
  useUIStore.getState().pushToast({ kind, text, duration: kind === 'error' ? 8000 : 3000 })
}

export function toRenderDoc(data: ProjectData): RenderDoc {
  return {
    title: data.meta.title,
    blocks: data.blocks.map((b) => (b.type === 'heading' ? { type: 'heading', level: b.level, text: b.text } : { type: 'paragraph', text: b.text })),
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** 图片内嵌成 data: 地址的完整页面 */
export async function selfContainedHtml(data: ProjectData, style: RenderStyle = 'reading'): Promise<string> {
  const ctx = currentAssetCtx()
  return renderPage(toRenderDoc(data), {
    style,
    image: async (src) => {
      if (isRemote(src)) return src
      const bytes = ctx ? await readAsset(ctx, src) : null
      return bytes ? `data:${mimeOf(src)};base64,${toBase64(bytes)}` : null
    },
  })
}

export async function exportHtml(style: RenderStyle = 'reading'): Promise<void> {
  const data = useProjectStore.getState().data
  if (!data) return
  try {
    const name = `${safeFileName(data.meta.title)}.html`
    const path = await saveTextFile(name, await selfContainedHtml(data, style), { name: '网页', extensions: ['html'] })
    if (path) toast('success', `已导出 ${isTauri ? path : name}（图片已内嵌，单个文件即可发送）`)
  } catch (e) {
    toast('error', `导出失败：${(e as Error).message}`)
  }
}

function hasLocalImages(data: ProjectData): boolean {
  return data.blocks.some((b) => {
    const img = b.type === 'paragraph' ? parseImage(b.text) : null
    return !!img && !isRemote(img.src)
  })
}

/**
 * Markdown：桌面版把图片复制到 .md 旁边的 `<名字>.assets/` 并改写路径；
 * 浏览器模式只能下载一个文件，图片不在其中（提示改用 HTML）。
 */
export async function exportMarkdownFile(): Promise<void> {
  const data = useProjectStore.getState().data
  if (!data) return
  const name = `${safeFileName(data.meta.title)}.md`
  try {
    if (!isTauri || !hasLocalImages(data)) {
      const path = await saveTextFile(name, exportMarkdown(data), { name: 'Markdown', extensions: ['md'] })
      if (!path) return
      if (!isTauri && hasLocalImages(data)) toast('info', '已导出 Markdown，但浏览器模式下图片没法一起导出；需要带图请导出 HTML')
      else toast('success', `已导出 ${isTauri ? path : name}`)
      return
    }
    const path = await pickSavePath(name, { name: 'Markdown', extensions: ['md'] })
    if (!path) return
    const ctx = currentAssetCtx()!
    const sep = path.includes('\\') ? '\\' : '/'
    const dir = path.slice(0, path.lastIndexOf(sep))
    const stem = path.slice(path.lastIndexOf(sep) + 1).replace(/\.(md|markdown)$/i, '')
    let copied = 0
    const missing: string[] = []
    const blocks = []
    for (const b of data.blocks) {
      const img = b.type === 'paragraph' ? parseImage(b.text) : null
      if (!img || isRemote(img.src)) {
        blocks.push(b)
        continue
      }
      const bytes = await readAsset(ctx, img.src)
      if (!bytes) {
        missing.push(img.src)
        blocks.push(b)
        continue
      }
      const fileName = img.src.split('/').pop()!
      await writeBinaryAt(`${dir}${sep}${stem}.assets${sep}${fileName}`, bytes)
      blocks.push({ ...b, text: imageLine(img.caption, `${stem}.assets/${fileName}`) })
      copied++
    }
    await writeFileAt(path, exportMarkdown({ ...data, blocks }))
    toast(
      missing.length ? 'info' : 'success',
      `已导出 ${path}（${copied} 张图片在 ${stem}.assets 里${missing.length ? `，${missing.length} 张找不到` : ''}）`
    )
  } catch (e) {
    toast('error', `导出失败：${(e as Error).message}`)
  }
}

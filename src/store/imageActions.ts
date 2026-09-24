/**
 * 插图：粘贴、拖入或从菜单选择的图片存进文稿的资源文件夹，
 * 在指定段落后面插入图片段落（`![图注](路径)`）。
 */
import type { ProjectData } from '../types'
import { assetUrl, putAsset, type AssetCtx } from '../lib/assets'
import { extFromMime, extOf, imageLine, isImageName, isRemote, mimeOf, parseImage } from '../lib/images'
import { insertParagraphAfter } from '../lib/doc'
import type { PickedImage } from '../lib/platform'
import { useProjectStore } from './projectStore'
import { useDocsStore } from './docsStore'
import { useUIStore } from './uiStore'

export function currentAssetCtx(): AssetCtx | null {
  const cur = useDocsStore.getState().current
  return cur ? { docId: cur.id, path: cur.path } : null
}

/** 插在哪里：正在编辑 / 选中的块之后；都没有就放文末 */
function anchor(data: ProjectData): string | null {
  const ui = useUIStore.getState()
  const id = ui.editing?.id ?? ui.selection?.ids.at(-1) ?? ui.activeId
  if (id && data.blocks.some((b) => b.id === id)) return id
  return data.blocks.at(-1)?.id ?? null
}

export async function insertImages(images: PickedImage[], afterId?: string | null): Promise<number> {
  const ctx = currentAssetCtx()
  const data = useProjectStore.getState().data
  const ui = useUIStore.getState()
  const usable = images.filter((i) => i.bytes.length && (isImageName(i.name) || !extOf(i.name)))
  if (!ctx || !data || !usable.length) return 0
  ui.confirmEdit()
  let after = afterId === undefined ? anchor(data) : afterId
  const srcs: string[] = []
  try {
    for (const img of usable) {
      srcs.push(await putAsset(ctx, img.bytes, extOf(img.name) || extFromMime(mimeOf(img.name))))
    }
  } catch (e) {
    ui.pushToast({ kind: 'error', text: `图片保存失败：${(e as Error).message}`, duration: 8000 })
    return 0
  }
  let last: string | null = null
  useProjectStore.getState().mutate((d) => {
    for (const src of srcs) {
      last = insertParagraphAfter(d, after, imageLine('', src))
      after = last
    }
  })
  if (last) ui.setActive(last)
  ui.pushToast({
    kind: 'success',
    text: srcs.length > 1 ? `已插入 ${srcs.length} 张图片` : '已插入图片 · 按 E 写图注',
    actionLabel: '撤销',
    onAction: () => useProjectStore.getState().undo(),
    duration: 5000,
  })
  return srcs.length
}

/** 显示用的图片地址（本地图片读出来转成 blob: 地址） */
export async function imageUrl(src: string): Promise<string | null> {
  if (isRemote(src)) return src
  const ctx = currentAssetCtx()
  return ctx ? assetUrl(ctx, src) : null
}

export function captionOf(text: string): string {
  return parseImage(text)?.caption ?? ''
}

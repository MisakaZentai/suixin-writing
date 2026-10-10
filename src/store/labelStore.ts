/**
 * 作者标注（"读着像 AI"）：桌面版存在应用数据目录的 flavor-labels.json，
 * 浏览器模式存 localStorage。
 */
import { create } from 'zustand'
import {
  LABEL_FILE,
  addLabel,
  labelsOfDoc,
  makeLabel,
  parseLabelStore,
  removeLabel,
  serializeLabelStore,
  type FlavorLabel,
  type LabelStore,
} from '../lib/flavor/labels'
import { isTauri } from '../lib/platform'
import { getBlock } from '../lib/doc'
import { useProjectStore } from './projectStore'
import { useDocsStore } from './docsStore'
import { useUIStore } from './uiStore'

const LOCAL_KEY = 'suixin:flavor-labels'

async function filePath(): Promise<string> {
  const { appDataDir, join } = await import('@tauri-apps/api/path')
  return join(await appDataDir(), LABEL_FILE)
}

async function readStore(): Promise<LabelStore> {
  if (isTauri) {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
    const p = await filePath()
    return parseLabelStore((await exists(p)) ? await readTextFile(p) : null)
  }
  try {
    return parseLabelStore(localStorage.getItem(LOCAL_KEY))
  } catch {
    return parseLabelStore(null)
  }
}

async function writeStore(store: LabelStore): Promise<void> {
  const text = serializeLabelStore(store)
  if (isTauri) {
    const { dirname } = await import('@tauri-apps/api/path')
    const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs')
    const p = await filePath()
    await mkdir(await dirname(p), { recursive: true }).catch(() => {})
    await writeTextFile(p, text)
    return
  }
  try {
    localStorage.setItem(LOCAL_KEY, text)
  } catch {
    /* 存不了也不影响本次使用 */
  }
}

interface State {
  store: LabelStore
  loaded: boolean
  load: () => Promise<void>
  /** 标一段（或段里划选的一句）"读着像 AI"；已经标过同一处就取消 */
  toggle: (blockId: string, quote?: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useLabelStore = create<State>((set, get) => {
  const apply = async (next: LabelStore) => {
    set({ store: next })
    await writeStore(next)
  }
  return {
    store: parseLabelStore(null),
    loaded: false,
    load: async () => {
      const next = await readStore().catch(() => null)
      if (next) set({ store: next, loaded: true })
    },
    toggle: async (blockId, quote) => {
      if (!get().loaded) await get().load()
      const data = useProjectStore.getState().data
      const block = data ? getBlock(data, blockId) : null
      if (!data || !block || block.type !== 'paragraph') return
      const cur = useDocsStore.getState().current
      const doc = { id: cur?.id ?? null, path: cur?.path ?? null }
      const existing = labelsOfDoc(get().store, { id: doc.id, title: data.meta.title }).find(
        (l) => l.blockId === blockId && (l.quote ?? '') === (quote ?? '')
      )
      if (existing) {
        await apply(removeLabel(get().store, existing.id))
        useUIStore.getState().pushToast({ kind: 'info', text: '已取消「读着像 AI」的标记' })
        return
      }
      const label = makeLabel(data, block, doc, quote)
      await apply(addLabel(get().store, label))
      const total = get().store.labels.length
      useUIStore.getState().pushToast({
        kind: 'success',
        text: label.hits.length
          ? `已标记（第 ${total} 条）。引擎也抓到了这里`
          : `已标记（第 ${total} 条）。引擎没抓到这里，正是要补的地方`,
        actionLabel: '撤销',
        onAction: () => void get().remove(label.id),
      })
    },
    remove: async (id) => apply(removeLabel(get().store, id)),
  }
})

/** 当前文稿里的标注 */
export function useDocLabels(): FlavorLabel[] {
  const store = useLabelStore((s) => s.store)
  const title = useProjectStore((s) => s.data?.meta.title ?? '')
  const docId = useDocsStore((s) => s.current?.id ?? null)
  return labelsOfDoc(store, { id: docId, title })
}

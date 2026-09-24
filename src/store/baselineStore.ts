/**
 * App 里的 AI 味个人基线：桌面版存在应用数据目录的 flavor-baselines.json（与命令行共用），
 * 浏览器模式存 localStorage。改动后同步给 lib/flavor/baselines（检查结果随之重算）。
 */
import { create } from 'zustand'
import {
  BASELINE_FILE,
  baselineFromSources,
  getBaselineStore,
  parseBaselineStore,
  removeBaseline,
  serializeBaselineStore,
  setBaselineStore,
  setDefaultBaseline,
  upsertBaseline,
  type BaselineStore,
} from '../lib/flavor'
import { isTauri } from '../lib/platform'

const LOCAL_KEY = 'suixin:flavor-baselines'

async function filePath(): Promise<string> {
  const { appDataDir, join } = await import('@tauri-apps/api/path')
  return join(await appDataDir(), BASELINE_FILE)
}

async function readStore(): Promise<BaselineStore> {
  if (isTauri) {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
    const p = await filePath()
    return parseBaselineStore((await exists(p)) ? await readTextFile(p) : null)
  }
  try {
    return parseBaselineStore(localStorage.getItem(LOCAL_KEY))
  } catch {
    return parseBaselineStore(null)
  }
}

async function writeStore(store: BaselineStore): Promise<void> {
  const text = serializeBaselineStore(store)
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
  store: BaselineStore
  /** 基线变了就加一：订阅它的组件重算 AI 味 */
  revision: number
  /** 重新读一遍（命令行可能改过文件） */
  load: () => Promise<void>
  build: (name: string, sources: { name: string; text: string }[], makeDefault: boolean) => Promise<void>
  remove: (name: string) => Promise<void>
  setDefault: (name: string | null) => Promise<void>
}

export const useBaselineStore = create<State>((set, get) => {
  const apply = async (next: BaselineStore, persist: boolean) => {
    setBaselineStore(next)
    set({ store: next, revision: get().revision + 1 })
    if (persist) await writeStore(next)
  }
  return {
    store: getBaselineStore(),
    revision: 0,
    load: async () => {
      const next = await readStore().catch(() => null)
      if (next && JSON.stringify(next) !== JSON.stringify(get().store)) await apply(next, false)
    },
    build: async (name, sources, makeDefault) => {
      await apply(upsertBaseline(get().store, baselineFromSources(name, sources), makeDefault), true)
    },
    remove: async (name) => apply(removeBaseline(get().store, name), true),
    setDefault: async (name) => apply(setDefaultBaseline(get().store, name), true),
  }
})

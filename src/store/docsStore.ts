/**
 * 文稿管理：当前打开哪一篇、保存到哪里、保存状态、最近文稿列表。
 *
 * 规则：
 * - 任何改动在停笔约 0.8 秒后自动保存进文稿库（绑定了文件的同时写回文件）；
 * - 导入、新建、打开都是"另起一篇"，当前文稿先落盘，绝不被替换；
 * - Ctrl+S：桌面版未绑定文件时询问保存位置，否则立即落盘。
 */
import { create } from 'zustand'
import type { ProjectData } from '../types'
import { library, type DocEntry } from '../lib/library'
import { isTauri, pickOpenFile, readFileAt, saveTextFile, readLegacyRecovery, clearLegacyRecovery, type PickedFile } from '../lib/platform'
import {
  PROJECT_FILE_SUFFIX,
  createProject,
  exportMarkdown,
  parseProjectFile,
  projectFromText,
  safeFileName,
  serializeProject,
} from '../lib/project'
import { countChars } from '../lib/doc'
import { makeParagraph } from '../lib/markdown'
import { uid } from '../lib/ids'
import { reconcile } from '../lib/sync'
import { adoptLocalImages, copyAssets, imageSrcs, removeLibraryAssets, rewriteImageSrcs } from '../lib/assets'
import { useProjectStore } from './projectStore'
import { useUIStore } from './uiStore'

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error'

interface DocsStore {
  ready: boolean
  entries: DocEntry[]
  /** 当前文稿在文稿库里的 id 与绑定文件 */
  current: { id: string; path: string | null } | null
  status: SaveStatus
  error: string | null
  savedAt: string | null
  /** 绑定文件被外部改了正文、本地也有未保存改动：等作者选择 */
  external: { raw: string; data: ProjectData; summary: string } | null

  init: () => Promise<void>
  refresh: () => Promise<void>
  /** 新建空白文稿，返回第一段 id */
  newBlank: () => Promise<string | null>
  /** sourcePath：从文件导入时的原路径，用来找它引用的本地图片 */
  importText: (text: string, name?: string, sourcePath?: string | null) => Promise<void>
  /** 打开工程文件文本（v1 / v2），可带绑定路径 */
  openProjectText: (text: string, path?: string | null) => Promise<void>
  /** 按文件名判断是工程文件还是 Markdown / 纯文本 */
  openPicked: (file: PickedFile) => Promise<void>
  pickAndOpen: () => Promise<void>
  openEntry: (id: string) => Promise<void>
  closeCurrent: () => Promise<void>
  removeEntry: (id: string) => Promise<void>

  /** 有改动时安排一次自动保存 */
  schedule: () => void
  /** 立即落盘当前文稿 */
  flush: () => Promise<void>
  /** Ctrl+S */
  save: () => Promise<void>
  /** Ctrl+Shift+S：保存到指定位置（桌面版此后绑定该文件；浏览器下载一份） */
  saveAs: () => Promise<void>
  exportMarkdown: () => Promise<void>
  /** 检查绑定文件是否被外部（agent）改动 */
  checkExternal: () => Promise<void>
  /** 冲突时作者的选择：载入外部版本 / 保留自己的版本 */
  resolveExternal: (choice: 'theirs' | 'mine') => void
}

const AUTOSAVE_DELAY = 800
const LAST_OPEN_KEY = 'suixin:last-open'

let timer = 0
let chain: Promise<void> = Promise.resolve()
/** 绑定文件上次与 App 同步时的内容（读入或写出的那一版），用来发现外部改动 */
let synced: { raw: string; data: ProjectData } | null = null

/**
 * 要保存的内容：正在编辑的那一段按草稿计入（不产生版本）——
 * 否则一整段话只存在内存里，崩溃或强退就没了，状态却显示"已保存"。
 * stamp 用来判断保存期间是否又有新改动。
 */
function snapshot(): { data: ProjectData; stamp: string } | null {
  const ps = useProjectStore.getState()
  const data = ps.data
  if (!data) return null
  const editing = useUIStore.getState().editing
  const stamp = `${ps.revision}|${editing ? `${editing.id}|${editing.draft}` : ''}`
  const block = editing ? data.blocks.find((b) => b.id === editing.id) : undefined
  if (!editing || !block || block.text === editing.draft) return { data, stamp }
  const text = block.type === 'heading' ? editing.draft.replace(/\s*\n\s*/g, ' ').trim() : editing.draft
  return {
    data: { ...data, blocks: data.blocks.map((b) => (b.id === editing.id ? { ...b, text } : b)) },
    stamp,
  }
}

function toast(kind: 'success' | 'error' | 'info', text: string, extra?: { actionLabel: string; onAction: () => void }) {
  useUIStore.getState().pushToast({ kind, text, ...extra, duration: kind === 'error' ? 8000 : 2400 })
}

function rememberOpen(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_OPEN_KEY, id)
    else localStorage.removeItem(LAST_OPEN_KEY)
  } catch {
    /* ignore */
  }
}

export const useDocsStore = create<DocsStore>((set, get) => {
  /** 打开一篇（新）文稿：先保存当前的，再切换；撤销历史按文稿独立 */
  const open = async (data: ProjectData, id: string, path: string | null, persist: boolean, raw?: string) => {
    // 正在编辑的段落先写进当前文稿，再落盘
    useUIStore.getState().confirmEdit()
    await get().flush()
    synced = path && raw ? { raw, data } : null
    set({ current: { id, path }, status: persist ? 'pending' : 'saved', error: null, external: null })
    useUIStore.getState().resetForDocument()
    useProjectStore.getState().setDocument(data)
    rememberOpen(id)
    if (persist) await get().flush()
    else void get().refresh()
  }

  /** 绑定文件被外部改动：按 reconcile 的结论合并 / 载入 / 请作者选择 */
  const handleExternal = (raw: string) => {
    let ext: ProjectData
    try {
      ext = parseProjectFile(raw)
    } catch {
      return // 写到一半或损坏：下一轮再看
    }
    const local = useProjectStore.getState().data
    if (!local || !synced) return
    const localDirty = get().status !== 'saved' || useUIStore.getState().editing != null
    const r = reconcile(synced.data, local, ext, localDirty)
    const title = local.meta.title
    if (r.action === 'conflict') {
      set({ external: { raw, data: r.data, summary: r.summary } })
      return
    }
    useProjectStore.getState().replaceFromExternal(r.data)
    synced = { raw, data: ext }
    // 外部程序改了权限字段：以 App 为准，立即写回，不能让文件里留着越权的设定
    const forged = (ext.meta.agentAccess ?? 'propose') !== (local.meta.agentAccess ?? 'propose')
    if (forged) {
      // 只改了授权字段时正文没变、不会触发自动保存，要主动写回；
      // 否则文件里一直留着越权的设定，命令行会照它放行直接修改
      get().schedule()
    } else if (r.action === 'replace' || !localDirty) {
      window.clearTimeout(timer)
      set({ status: 'saved' })
    }
    useUIStore.getState().pushToast({
      kind: 'info',
      text: `《${title}》：${r.summary}`,
      actionLabel: '查看',
      onAction: () => useUIStore.getState().setSuggestionsOpen(true),
      duration: 6000,
    })
  }

  return {
    ready: false,
    entries: [],
    current: null,
    status: 'saved',
    error: null,
    savedAt: null,
    external: null,

    init: async () => {
      // 旧版只有一个"崩溃恢复"槽：迁移进文稿库，别让它丢
      try {
        const legacy = await readLegacyRecovery()
        if (legacy) {
          const data = parseProjectFile(legacy.content)
          const entry: DocEntry = {
            id: uid('d'),
            title: data.meta.title,
            updatedAt: legacy.at ?? new Date().toISOString(),
            chars: data.blocks.reduce((n, b) => n + countChars(b.text), 0),
            path: null,
          }
          await library.write(entry, serializeProject(data))
        }
        // 迁移成功（或本来就没有）才清理旧恢复槽；失败则留着下次再试
        await clearLegacyRecovery()
      } catch {
        /* 损坏或写入失败：保留旧数据 */
      }
      await get().refresh()
      set({ ready: true })
      // 桌面版：绑定文件可能被 agent 改动，定时看一眼
      if (isTauri) {
        window.setInterval(() => {
          if (document.visibilityState === 'visible') void get().checkExternal()
        }, 2000)
      }
      // 上次关闭时开着的文稿，启动时直接打开
      let last: string | null = null
      try {
        last = localStorage.getItem(LAST_OPEN_KEY)
      } catch {
        /* ignore */
      }
      if (last && get().entries.some((e) => e.id === last)) await get().openEntry(last)
    },

    refresh: async () => {
      try {
        set({ entries: await library.list() })
      } catch (e) {
        set({ error: (e as Error).message })
      }
    },

    newBlank: async () => {
      const first = makeParagraph('', 'manual')
      await open(createProject('未命名文稿', [first]), uid('d'), null, true)
      return first.id
    },

    importText: async (text, name, sourcePath) => {
      const { project, truncated } = projectFromText(text, name || '未命名文稿')
      const id = uid('d')
      // 从 Markdown 文件导入（桌面版）：把它引用的本地图片收进文稿自己的资源文件夹
      if (sourcePath && isTauri) await adoptLocalImages(project, sourcePath, { docId: id, path: null })
      await open(project, id, null, true)
      if (truncated) toast('info', '文档超过 20 万字，只导入了前 20 万字（原文件不受影响）')
    },

    openProjectText: async (text, path = null) => {
      const data = parseProjectFile(text)
      const existing = path ? get().entries.find((e) => e.path === path) : undefined
      await open(data, existing?.id ?? uid('d'), path, true, text)
    },

    openPicked: async (file) => {
      try {
        if (/\.json$/i.test(file.name)) await get().openProjectText(file.text, isTauri ? file.path : null)
        else await get().importText(file.text, file.name.replace(/\.[^.]+$/, ''), file.path)
      } catch (e) {
        toast('error', `打开失败：${(e as Error).message}`)
      }
    },

    pickAndOpen: async () => {
      try {
        const file = await pickOpenFile()
        if (file) await get().openPicked(file)
      } catch (e) {
        toast('error', `打开失败：${(e as Error).message}`)
      }
    },

    openEntry: async (id) => {
      if (get().current?.id === id) return
      try {
        const text = await library.read(id)
        if (!text) throw new Error('文稿内容已不存在')
        const entry = get().entries.find((e) => e.id === id)
        await open(parseProjectFile(text), id, entry?.path ?? null, false, text)
      } catch (e) {
        toast('error', `打开失败：${(e as Error).message}`)
      }
    },

    closeCurrent: async () => {
      useUIStore.getState().confirmEdit()
      await get().flush()
      useUIStore.getState().resetForDocument()
      useProjectStore.getState().setDocument(null)
      set({ current: null })
      rememberOpen(null)
      await get().refresh()
    },

    removeEntry: async (id) => {
      if (get().current?.id === id) await get().closeCurrent()
      chain = chain.then(async () => {
        await library.remove(id)
        await removeLibraryAssets(id).catch(() => {})
      })
      await chain
      await get().refresh()
    },

    schedule: () => {
      if (!get().current) return
      set({ status: 'pending' })
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void get().flush(), AUTOSAVE_DELAY)
    },

    flush: () => {
      window.clearTimeout(timer)
      const run = async () => {
        const { current, status } = get()
        const snap = snapshot()
        // 与外部改动冲突、等作者选择期间，不写文件
        if (!current || !snap || status === 'saved' || get().external) return
        // 绑定文件被别人（agent）改过：先对齐，绝不直接覆盖
        if (isTauri && current.path && synced) {
          const onDisk = await readFileAt(current.path).catch(() => null)
          if (onDisk != null && onDisk !== synced.raw) {
            handleExternal(onDisk)
            return
          }
        }
        const entry: DocEntry = {
          id: current.id,
          title: snap.data.meta.title,
          updatedAt: new Date().toISOString(),
          chars: snap.data.blocks.reduce((n, b) => n + countChars(b.text), 0),
          path: current.path,
        }
        set({ status: 'saving' })
        try {
          const json = serializeProject(snap.data)
          await library.write(entry, json)
          if (current.path) synced = { raw: json, data: snap.data }
          // 保存期间又有新改动（包括还在写的草稿）：保持"待保存"，由下一轮接手
          const changed = snapshot()?.stamp !== snap.stamp || get().current?.id !== current.id
          set({ status: changed ? 'pending' : 'saved', error: null, savedAt: entry.updatedAt })
          if (changed) get().schedule()
          void get().refresh()
        } catch (e) {
          set({ status: 'error', error: (e as Error).message || '保存失败' })
        }
      }
      // 所有写入排成一队：不会两次写入交叠（桌面版的索引文件是读-改-写）
      chain = chain.then(run, run)
      return chain
    },

    save: async () => {
      if (isTauri && get().current && !get().current!.path) {
        await get().saveAs()
        return
      }
      if (get().status !== 'saved') await get().flush()
      if (get().status === 'saved') {
        toast('success', isTauri ? '已保存' : '已保存到本机文稿库（另存为可下载文件）')
      }
    },

    saveAs: async () => {
      const data = useProjectStore.getState().data
      const current = get().current
      if (!data || !current) return
      try {
        const name = `${safeFileName(data.meta.title)}${PROJECT_FILE_SUFFIX}`
        const path = await saveTextFile(name, serializeProject(data), {
          name: '随心写作文稿',
          extensions: ['json'],
        })
        if (!path) return
        if (isTauri) {
          // 图片跟着走：复制到新文件旁边的资源文件夹，并改写文稿里的引用
          const srcs = imageSrcs(data)
          if (srcs.length) {
            const moved = await copyAssets({ docId: current.id, path: current.path }, { docId: current.id, path }, srcs)
            if (moved.size) useProjectStore.getState().replaceFromExternal(rewriteImageSrcs(data, moved))
          }
          // 换了文件：旧文件的同步基准不再适用，否则新文件会被误判成"被外部改过"
          synced = null
          set({ current: { ...current, path }, status: 'pending' })
          await get().flush()
          toast('success', `已保存到 ${path}`)
        } else {
          toast('success', `已下载 ${name}`)
        }
      } catch (e) {
        toast('error', `保存失败：${(e as Error).message}`)
      }
    },

    checkExternal: async () => {
      const { current, external } = get()
      if (!isTauri || !current?.path || !synced || external) return
      const onDisk = await readFileAt(current.path).catch(() => null)
      if (onDisk != null && onDisk !== synced.raw && get().current?.id === current.id) handleExternal(onDisk)
    },

    resolveExternal: (choice) => {
      const ext = get().external
      if (!ext) return
      if (choice === 'theirs') {
        useUIStore.getState().confirmEdit()
        // 自己的改动留在撤销历史里，Ctrl+Z 还能找回
        useProjectStore.getState().replaceFromExternal(ext.data)
        synced = { raw: ext.raw, data: ext.data }
        window.clearTimeout(timer)
        set({ external: null, status: 'saved' })
      } else {
        synced = { raw: ext.raw, data: ext.data }
        set({ external: null })
        get().schedule()
      }
    },

    exportMarkdown: async () => {
      // 带图片的导出在 exportActions 里（桌面版连同图片文件夹）；动态引入避免循环依赖
      const { exportMarkdownFile } = await import('./exportActions')
      await exportMarkdownFile()
    },
  }
})

/* 内容一变就安排自动保存 */
useProjectStore.subscribe((s, prev) => {
  if (s.data && s.data !== prev.data && s.revision !== prev.revision) {
    useDocsStore.getState().schedule()
  }
})

/* 正在编辑的草稿也一样：停笔 0.8 秒存一次 */
useUIStore.subscribe((s, prev) => {
  if (s.editing && prev.editing && s.editing.id === prev.editing.id && s.editing.draft !== prev.editing.draft) {
    useDocsStore.getState().schedule()
  }
})

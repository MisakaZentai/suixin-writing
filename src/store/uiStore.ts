/**
 * UI 状态仓库：选中/编辑/意见/流式/diff 确认/大纲面板/主题/Toast。
 * AI 编排放在这里：流式生成 → 自动进入内联 diff → 逐处确认（spec F3/F4）。
 */
import { create } from 'zustand'
import type { Granularity, OutlineNode, ProjectData } from '../types'
import { secret } from '../lib/platform'
import { Typewriter } from '../lib/typewriter'
import {
  chatStream,
  expandMessages,
  inferOutline,
  reviseMessages,
  rewriteMessages,
  checkAlignment,
  type AIConfig,
} from '../lib/ai'
import { clusterize } from '../lib/diff'
import { getDisplayBlocks } from '../lib/project'
import { useProjectStore } from './projectStore'

export interface Toast {
  id: string
  kind: 'success' | 'error' | 'info'
  text: string
  actionLabel?: string
  onAction?: () => void
  duration: number
}

export interface StreamState {
  key: string
  tw: Typewriter
  controller: AbortController
  kind: 'rewrite' | 'revise'
  instruction: string | null
}

export interface DiffState {
  suggestionId: string
  decisions: (boolean | undefined)[]
  focused: number
}

interface UIStore {
  granularity: Granularity
  activeKey: string | null
  editing: { key: string; draft: string } | null
  opinion: { key: string; draft: string } | null
  stream: StreamState | null
  diff: DiffState | null
  sidebarOpen: boolean
  sidebarWidth: number
  settingsOpen: boolean
  helpOpen: boolean
  versionPanelKey: string | null
  suggestionsOpen: boolean
  contextMenu: { x: number; y: number; key: string } | null
  importOpen: boolean
  locateRequest: { key: string; nonce: number } | null
  apiKeyPresent: boolean
  theme: 'system' | 'light' | 'dark'
  toasts: Toast[]

  setGranularity: (g: Granularity) => void
  setActive: (key: string | null) => void
  requestLocate: (key: string) => void

  beginEdit: (key: string, draft: string) => void
  updateEditDraft: (draft: string) => void
  confirmEdit: () => void
  cancelEdit: () => void

  beginOpinion: (key: string) => void
  updateOpinionDraft: (draft: string) => void
  cancelOpinion: () => void

  startRewrite: (key: string) => Promise<void>
  startRevise: (key: string) => Promise<void>
  abortAI: () => void
  expandNode: (nodeId: string) => Promise<void>
  runAlignmentCheck: (nodeId: string) => Promise<void>
  runInferOutline: () => Promise<void>
  retrySuggestion: (suggestionId: string) => Promise<void>

  openDiff: (suggestionId: string) => void
  closeDiff: () => void
  setDecision: (index: number, accepted: boolean) => void
  focusCluster: (index: number) => void
  decideAll: (accepted: boolean) => void

  setSidebarOpen: (open: boolean) => void
  setSidebarWidth: (w: number) => void
  setSettingsOpen: (open: boolean) => void
  setHelpOpen: (open: boolean) => void
  setVersionPanelKey: (key: string | null) => void
  setSuggestionsOpen: (open: boolean) => void
  setContextMenu: (m: { x: number; y: number; key: string } | null) => void
  setImportOpen: (open: boolean) => void
  setTheme: (t: 'system' | 'light' | 'dark') => void
  refreshApiKeyPresence: () => Promise<void>

  pushToast: (t: {
    kind: Toast['kind']
    text: string
    actionLabel?: string
    onAction?: () => void
    duration?: number
  }) => void
  dismissToast: (id: string) => void
}

const PREFS_KEY = 'ai-writer:prefs'

interface Prefs {
  granularity: Granularity
  sidebarOpen: boolean
  sidebarWidth: number
  theme: 'system' | 'light' | 'dark'
}

function loadPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function savePrefs(p: Partial<Prefs>): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...p }))
  } catch {
    /* ignore */
  }
}

let toastSeq = 0
export const useUIStore = create<UIStore>((set, get) => ({
  granularity: loadPrefs().granularity ?? 'paragraph',
  activeKey: null,
  editing: null,
  opinion: null,
  stream: null,
  diff: null,
  sidebarOpen: loadPrefs().sidebarOpen ?? true,
  sidebarWidth: loadPrefs().sidebarWidth ?? 260,
  settingsOpen: false,
  helpOpen: false,
  versionPanelKey: null,
  suggestionsOpen: false,
  contextMenu: null,
  importOpen: false,
  locateRequest: null,
  apiKeyPresent: false,
  theme: loadPrefs().theme ?? 'system',
  toasts: [],

  setGranularity: (g) => {
    savePrefs({ granularity: g })
    set({ granularity: g, activeKey: null, editing: null, opinion: null })
  },
  setActive: (key) =>
    set({ activeKey: key, editing: null, opinion: null, versionPanelKey: null }),
  requestLocate: (key) =>
    set((s) => ({
      locateRequest: { key, nonce: (s.locateRequest?.nonce ?? 0) + 1 },
    })),

  beginEdit: (key, draft) => set({ editing: { key, draft } }),
  updateEditDraft: (draft) =>
    set((s) => (s.editing ? { editing: { ...s.editing, draft } } : {})),
  confirmEdit: () => {
    const { editing } = get()
    if (!editing) return
    const newIds = useProjectStore
      .getState()
      .applyGroupEdit(editing.key, { text: editing.draft, source: 'manual' })
    set({ editing: null })
    if (newIds.length) get().setActive(`s:${newIds[0]}`)
  },
  cancelEdit: () => set({ editing: null }),

  beginOpinion: (key) => set({ opinion: { key, draft: '' } }),
  updateOpinionDraft: (draft) =>
    set((s) => (s.opinion ? { opinion: { ...s.opinion, draft } } : {})),
  cancelOpinion: () => set({ opinion: null }),

  /* ── AI 编排 ───────────────────────────────────────── */

  startRewrite: async (key) => {
    await startAI(set, get, key, 'rewrite', null)
  },
  startRevise: async (key) => {
    const instruction = get().opinion?.draft.trim() ?? ''
    if (!instruction) {
      get().pushToast({ kind: 'error', text: '请先输入修改意见' })
      return
    }
    set({ opinion: null })
    await startAI(set, get, key, 'revise', instruction)
  },
  abortAI: () => {
    const { stream } = get()
    if (!stream) return
    stream.controller.abort()
    stream.tw.finish() // 保留已生成部分，交由 diff 处理
  },

  expandNode: async (nodeId) => {
    const project = useProjectStore.getState().data
    if (!project) return
    const config = await readConfig(get)
    if (!config) return
    const blocks = getDisplayBlocks(project, get().granularity)
    const nodeBlocks = blocks.filter((b) => b.outlineNodeId === nodeId)
    const flat = flattenToMap(project)
    const node = flat.get(nodeId)
    if (!node) return
    get().pushToast({ kind: 'info', text: `AI 正在扩写「${node.title}」…` })
    try {
      const gen = chatStream(
        config,
        expandMessages(project, node, nodeBlocks, blocks)
      )
      const result = await runStreamToSuggestion(set, get, {
        gen,
        key: nodeBlocks.length ? nodeBlocks[0].key : 'full',
        kind: 'revise',
        instruction: `扩写章节：${node.title}`,
        scope: 'paragraph',
        emptyTarget: nodeBlocks.length === 0 ? { nodeId } : undefined,
      })
      if (result === 'aborted') return
      get().pushToast({ kind: 'success', text: '扩写完成，请确认 diff' })
    } catch (e) {
      failAI(set, get, e)
    }
  },

  runAlignmentCheck: async (nodeId) => {
    const project = useProjectStore.getState().data
    if (!project) return
    const config = await readConfig(get)
    if (!config) return
    const flat = flattenToMap(project)
    const node = flat.get(nodeId)
    if (!node) return
    const blocks = getDisplayBlocks(project, 'paragraph').filter(
      (b) => b.outlineNodeId === nodeId
    )
    if (!blocks.length) {
      get().pushToast({ kind: 'info', text: '该节点下暂无正文块' })
      return
    }
    get().pushToast({ kind: 'info', text: `AI 正在检查「${node.title}」…` })
    try {
      const issues = await checkAlignment(config, project, node, blocks)
      const created = issues
        .map((issue) => {
          const block = blocks[issue.index - 1]
          if (!block) return null
          return {
            id: `s_align_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            blockId: block.blockIds[0],
            kind: 'alignment' as const,
            instruction: issue.advice,
            proposed: '',
            diff: [],
            state: 'pending' as const,
            createdAt: new Date().toISOString(),
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
      const pstore = useProjectStore.getState()
      pstore.capture()
      useProjectStore.setState((s) => {
        if (!s.data) return
        s.data.suggestions.push(...created)
      })
      get().setSuggestionsOpen(true)
      get().pushToast({
        kind: created.length ? 'success' : 'info',
        text: created.length
          ? `发现 ${created.length} 条对齐建议，详见「待办」`
          : '该章节与大纲一致，未发现问题',
      })
    } catch (e) {
      failAI(set, get, e)
    }
  },

  runInferOutline: async () => {
    const project = useProjectStore.getState().data
    if (!project) return
    const config = await readConfig(get)
    if (!config) return
    get().pushToast({ kind: 'info', text: 'AI 正在反推大纲…' })
    try {
      const inferred = await inferOutline(config, project)
      const pstore = useProjectStore.getState()
      pstore.capture()
      useProjectStore.setState((s) => {
        if (!s.data) return
        let seq = 0
        type InNode = { title: string; children?: InNode[] }
        type OutNode = OutlineNode
        const build = (nodes: InNode[]): OutNode[] =>
          nodes.map((n) => ({
            id: `on_ai_${(seq++).toString(36)}`,
            title: n.title,
            children: build(n.children ?? []),
          }))
        s.data.outline = build(inferred.outline ?? [])
        if (inferred.title) s.data.meta.title = inferred.title
      })
      get().pushToast({ kind: 'success', text: '大纲已生成，可在左侧调整' })
    } catch (e) {
      failAI(set, get, e)
    }
  },

  retrySuggestion: async (suggestionId) => {
    const project = useProjectStore.getState().data
    const suggestion = project?.suggestions.find((x) => x.id === suggestionId)
    if (!project || !suggestion) return
    if (suggestion.kind === 'alignment') {
      // 对齐建议 → 转为一次“提意见”修改
      const key = `p:${
        project.blocks.find((b) => b.id === suggestion.blockId)?.paragraphId ?? ''
      }`
      useProjectStore.getState().dismissSuggestion(suggestionId)
      get().beginOpinion(key)
      get().updateOpinionDraft(suggestion.instruction ?? '')
      get().pushToast({ kind: 'info', text: '已填入建议，Ctrl+Enter 提交修改' })
      return
    }
    useProjectStore.getState().dismissSuggestion(suggestionId)
    await startAI(
      set,
      get,
      `p:${
        project.blocks.find((b) => b.id === suggestion.blockId)?.paragraphId ?? ''
      }`,
      suggestion.instruction ? 'revise' : 'rewrite',
      suggestion.instruction
    )
  },

  /* ── diff 确认 ─────────────────────────────────────── */

  openDiff: (suggestionId) => {
    const project = useProjectStore.getState().data
    const sg = project?.suggestions.find((s) => s.id === suggestionId)
    if (!sg) return
    const count = Math.max(1, clusterize(sg.diff).length)
    set({
      diff: {
        suggestionId,
        decisions: new Array(count).fill(undefined),
        focused: 0,
      },
      editing: null,
    })
  },
  closeDiff: () => set({ diff: null }),
  setDecision: (index, accepted) =>
    set((s) => {
      if (!s.diff) return {}
      const decisions = [...s.diff.decisions]
      decisions[index] = accepted
      const nextOpen = decisions.findIndex((d) => d === undefined)
      return {
        diff: {
          ...s.diff,
          decisions,
          focused: nextOpen >= 0 ? nextOpen : s.diff.focused,
        },
      }
    }),
  focusCluster: (index) =>
    set((s) =>
      s.diff ? { diff: { ...s.diff, focused: index } } : {}
    ),
  decideAll: (accepted) =>
    set((s) =>
      s.diff
        ? {
            diff: {
              ...s.diff,
              decisions: s.diff.decisions.map(() => accepted),
            },
          }
        : {}
    ),

  /* ── 面板开关 ──────────────────────────────────────── */

  setSidebarOpen: (open) => {
    savePrefs({ sidebarOpen: open })
    set({ sidebarOpen: open })
  },
  setSidebarWidth: (w) => {
    savePrefs({ sidebarWidth: w })
    set({ sidebarWidth: w })
  },
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setVersionPanelKey: (key) => set({ versionPanelKey: key }),
  setSuggestionsOpen: (open) => set({ suggestionsOpen: open }),
  setContextMenu: (menu) => set({ contextMenu: menu }),
  setImportOpen: (open) => set({ importOpen: open }),
  setTheme: (t) => {
    savePrefs({ theme: t })
    set({ theme: t })
    applyTheme(t)
  },
  refreshApiKeyPresence: async () => {
    const key = await secret.get('apiKey')
    set({ apiKeyPresent: Boolean(key) })
  },

  pushToast: (t) => {
    const id = `t_${++toastSeq}`
    set((s) => ({
      toasts: [...s.toasts, { ...t, id, duration: t.duration ?? 2000 }].slice(-3),
    }))
    if ((t.duration ?? 2000) > 0) {
      setTimeout(() => get().dismissToast(id), t.duration ?? 2000)
    }
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/* ── 内部工具 ────────────────────────────────────────── */

function applyTheme(t: 'system' | 'light' | 'dark'): void {
  const dark =
    t === 'dark' ||
    (t === 'system' &&
      matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
}

function flattenToMap(project: ProjectData): Map<string, ProjectData['outline'][number]> {
  const map = new Map<string, ProjectData['outline'][number]>()
  const walk = (nodes: ProjectData['outline']) => {
    for (const n of nodes) {
      map.set(n.id, n)
      walk(n.children)
    }
  }
  walk(project.outline)
  return map
}

/** 从安全存储读取 Key + 工程设置组装 AIConfig；无 Key 时提示并返回 null */
async function readConfig(get: Getter): Promise<AIConfig | null> {
  const project = useProjectStore.getState().data
  const apiKey = (await secret.get('apiKey')) ?? ''
  void get().refreshApiKeyPresence()
  if (!project) return null
  if (!apiKey) {
    get().pushToast({
      kind: 'error',
      text: '尚未配置 API Key，请前往「设置」',
      actionLabel: '去设置',
      onAction: () => useUIStore.setState({ settingsOpen: true }),
    })
    return null
  }
  return {
    baseURL: project.settings.baseURL,
    apiKey,
    model: project.settings.model,
    temperature: project.settings.temperature,
  }
}

function failAI(
  set: (partial: Partial<UIStore>) => void,
  get: () => UIStore,
  e: unknown
): void {
  set({ stream: null })
  get().pushToast({
    kind: 'error',
    text: `AI 处理失败：${(e as Error).message || '未知错误'}`,
  })
}

type Setter = (partial: Partial<UIStore>) => void
type Getter = () => UIStore

/** 通用流式执行：喝完流 → 生成打字机展示 → 落建议 + 打开 diff */
async function runStreamToSuggestion(
  set: Setter,
  get: Getter,
  opts: {
    gen: AsyncGenerator<string, void, unknown>
    key: string
    kind: 'rewrite' | 'revise'
    instruction: string | null
    scope: 'full' | 'paragraph' | 'sentence'
    /** 扩写空章节：流式结束后新建挂靠块的 diff */
    emptyTarget?: { nodeId: string }
  }
): Promise<'done' | 'aborted' | 'empty'> {
  const controller = new AbortController()
  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  const tw = new Typewriter(reduced)
  set({
    stream: {
      key: opts.key,
      tw,
      controller,
      kind: opts.kind,
      instruction: opts.instruction,
    },
  })
  let received = ''
  let aborted = false
  try {
    for await (const chunk of opts.gen) {
      received += chunk
      tw.push(chunk)
    }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      aborted = true
    } else {
      throw e
    }
  }
  tw.finish()
  if (aborted && received.trim().length < 8) {
    set({ stream: null })
    get().pushToast({ kind: 'info', text: '已中断，未采用任何结果' })
    return 'aborted'
  }
  if (!received.trim()) {
    set({ stream: null })
    get().pushToast({ kind: 'info', text: 'AI 未返回内容，请重试' })
    return 'empty'
  }
  const proposed = received.trim()
  const suggestionId = opts.emptyTarget
    ? useProjectStore.getState().createExpandSuggestion({
        nodeId: opts.emptyTarget.nodeId,
        proposed,
        instruction: opts.instruction,
      })
    : useProjectStore.getState().createSuggestion({
        blockKey: opts.key,
        proposed,
        instruction: opts.instruction,
        scope: opts.scope,
      })
  set({ stream: null })
  if (!suggestionId) {
    get().pushToast({ kind: 'error', text: '无法定位目标块，操作已取消' })
    return 'empty'
  }
  get().openDiff(suggestionId)
  if (aborted) {
    get().pushToast({ kind: 'info', text: '已中断，可基于已生成部分确认' })
  }
  return aborted ? 'aborted' : 'done'
}

/** 块级 AI：重写 / 按意见修改 */
async function startAI(
  set: Setter,
  get: Getter,
  key: string,
  kind: 'rewrite' | 'revise',
  instruction: string | null
): Promise<void> {
  if (get().stream) {
    get().pushToast({ kind: 'info', text: '已有生成任务进行中' })
    return
  }
  const project = useProjectStore.getState().data
  if (!project) return
  const config = await readConfig(get)
  if (!config) return
  const blocks = getDisplayBlocks(project, get().granularity)
  const block = blocks.find((b) => b.key === key)
  if (!block) return
  const scope =
    key === 'full' ? 'full' : key.startsWith('s:') ? 'sentence' : 'paragraph'
  get().setActive(key)
  const messages =
    kind === 'rewrite'
      ? rewriteMessages(project, block, blocks)
      : reviseMessages(project, block, blocks, instruction ?? '')
  try {
    const gen = chatStream(config, messages)
    await runStreamToSuggestion(set, get, {
      gen,
      key,
      kind,
      instruction,
      scope,
    })
  } catch (e) {
    failAI(set, get, e)
  }
}


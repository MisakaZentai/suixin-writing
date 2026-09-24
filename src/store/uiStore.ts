/**
 * 界面状态：选中 / 选区 / 编辑 / AI 指令框 / 流式 / diff 确认 / 面板 / 主题 / 提示条。
 * AI 编排（发请求、落建议）在 aiActions.ts，这里只管界面状态。
 */
import { create } from 'zustand'
import type { Typewriter } from '../lib/typewriter'
import { WHOLE_REWRITE_RATIO, applyDecisions, changeRatio, clusterize } from '../lib/diff'
import {
  convertBlock,
  editBlock,
  getBlock,
  indexOfBlock,
  insertParagraphAfter,
  mergeWithPrevious,
  sectionBodyIds,
  splitParagraph,
} from '../lib/doc'
import { useProjectStore } from './projectStore'
import { isImageText } from '../lib/images'

export interface Toast {
  id: string
  kind: 'success' | 'error' | 'info'
  text: string
  actionLabel?: string
  onAction?: () => void
  duration: number
}

/** 流式生成 / diff 在界面上的落点 */
export interface Placement {
  /** 渲染生成内容的块（插入型为插入位置前一块，可能为 null 表示文首） */
  anchorId: string | null
  /** 被替换、生成期间需要收起的块 */
  blockIds: string[]
  /** 插入型：新内容出现在 anchorId 之后 */
  insert: boolean
}

export interface StreamState extends Placement {
  tw: Typewriter
  controller: AbortController
  instruction: string | null
}

export type DiffViewMode = 'marked' | 'result' | 'compare'

export interface DiffState extends Placement {
  suggestionId: string
  decisions: (boolean | undefined)[]
  focused: number
  /** 标注（逐处裁决）/ 修改后 / 前后对照 */
  view: DiffViewMode
  /** 改动过大：只能整体接受或放弃 */
  whole: boolean
}

/**
 * AI 的作用范围，由当前选区决定：
 * - paragraphs：一段或连续多段
 * - range：段内选中的一段文字
 * - section：一个标题下的正文（可能还是空的）
 */
export interface AIScope {
  kind: 'paragraphs' | 'range' | 'section'
  blockIds: string[]
  range?: [number, number] | null
  headingId?: string
  /** 指令框渲染在哪一块下方 */
  anchorId: string
  /** 给用户看的范围说明，如"这一段""选中的 3 段" */
  label: string
  /** 段内选区的文字预览 */
  preview?: string
}

/** 段内文字选区（鼠标划选） */
export interface TextRange {
  blockId: string
  start: number
  end: number
  /** 选区在视口中的位置，用于摆放浮动按钮 */
  rect: { top: number; left: number; width: number; bottom: number }
}

/** 连续多块选区（Shift+↑↓ / Shift+点击 / 跨段划选） */
export interface BlockSelection {
  anchorId: string
  focusId: string
  ids: string[]
}

/** AI 划分章节的提案：作者勾选、改名、调层级后再插入 */
export interface OutlineProposal {
  title: string
  items: { beforeId: string; level: number; title: string; snippet: string; include: boolean }[]
}

export interface AIError {
  anchorId: string
  message: string
  retry?: () => void
}

interface UIStore {
  activeId: string | null
  selection: BlockSelection | null
  textRange: TextRange | null
  /** caret + token：需要把光标放到指定位置时 token 自增，编辑框据此重新定位 */
  editing: { id: string; draft: string; caret?: number; token: number } | null
  aiPrompt: { scope: AIScope; draft: string } | null
  aiError: AIError | null
  outlineProposal: OutlineProposal | null
  stream: StreamState | null
  diff: DiffState | null
  sidebarOpen: boolean
  sidebarWidth: number
  settingsOpen: boolean
  helpOpen: boolean
  briefOpen: boolean
  agentOpen: boolean
  /** 「发布到知乎」面板 */
  publishOpen: boolean
  versionPanelId: string | null
  suggestionsOpen: boolean
  /** AI 味面板（与待办面板占同一个位置，二选一）；打开时正文里标出命中 */
  flavorOpen: boolean
  contextMenu: { x: number; y: number; id: string } | null
  importOpen: boolean
  locateRequest: { id: string; nonce: number } | null
  theme: 'system' | 'light' | 'dark'
  bodyFont: BodyFont
  /** Markdown 模式：不在编辑的段落按 Markdown 渲染，编辑时语法就地生效；关掉则一律显示源码 */
  markdown: boolean
  /** 正文字号：auto 随窗口宽度在 17–21px 之间变化 */
  textSize: TextSize
  /** 正文列宽度：每行大约多少字 */
  measure: Measure
  toasts: Toast[]
  /** 最近一次块级快捷键回声（'e' | 'ai'），140ms 后自动清除 */
  keyEcho: string | null

  setActive: (id: string | null) => void
  /** 选中 from 到 to 之间的所有块 */
  selectRange: (fromId: string, toId: string) => void
  /** Shift+↑ / ↓：从当前块向上 / 下扩展选区 */
  extendSelection: (dir: -1 | 1) => void
  setTextRange: (range: TextRange | null) => void
  requestLocate: (id: string) => void
  /** 切换文稿时清空所有与当前文稿相关的界面状态 */
  resetForDocument: () => void

  beginEdit: (id: string, caret?: number) => void
  updateEditDraft: (draft: string) => void
  /** 完成编辑：写入版本历史；清空的段落自动移除 */
  confirmEdit: () => void
  cancelEdit: () => void
  /** 编辑中按回车：在光标处分段，继续编辑下半段 */
  splitAtCaret: (start: number, end: number) => void
  /** 编辑中在段首按退格：与上一段合并；返回是否已处理 */
  mergeUpFromEdit: () => boolean
  /** 编辑中在段尾按 Delete：把下一段并进来；返回是否已处理 */
  mergeDownFromEdit: () => boolean
  /** 编辑中在段首按 ↑ / 段尾按 ↓：移到相邻块继续编辑；返回是否已处理 */
  moveEdit: (dir: -1 | 1) => boolean
  /** 在文末续写：末段为空则直接编辑它，否则新起一段 */
  continueWriting: () => void

  /** 打开 AI 指令框；不传 scope 时按当前选区推断，推断失败会给出提示 */
  openAIPrompt: (scope?: AIScope, draft?: string) => boolean
  updatePromptDraft: (draft: string) => void
  closeAIPrompt: () => void
  setAIError: (error: AIError | null) => void
  setOutlineProposal: (p: OutlineProposal | null) => void

  openDiff: (suggestionId: string) => void
  /** 稍后再说：收起对照，建议保留为待确认 */
  closeDiff: () => void
  setDecision: (index: number, accepted: boolean) => void
  focusCluster: (index: number) => void
  setDiffView: (view: DiffViewMode) => void
  /** 接受：按逐处裁决落地，未裁决的按接受处理 */
  acceptDiff: () => string[] | null
  /** 放弃这条修改 */
  rejectDiff: () => void
  /** 接受当前结果并进入编辑，在 AI 的稿子上接着改 */
  acceptAndEdit: () => void
  /** 在多个候选之间切换 */
  switchCandidate: (delta: -1 | 1) => void

  setSidebarOpen: (open: boolean) => void
  setSidebarWidth: (w: number) => void
  setSettingsOpen: (open: boolean) => void
  setHelpOpen: (open: boolean) => void
  setBriefOpen: (open: boolean) => void
  setAgentOpen: (open: boolean) => void
  setPublishOpen: (open: boolean) => void
  setVersionPanelId: (id: string | null) => void
  setSuggestionsOpen: (open: boolean) => void
  setFlavorOpen: (open: boolean) => void
  setContextMenu: (m: { x: number; y: number; id: string } | null) => void
  setImportOpen: (open: boolean) => void
  setTheme: (t: 'system' | 'light' | 'dark') => void
  setBodyFont: (f: BodyFont) => void
  setMarkdown: (on: boolean) => void
  setTextSize: (t: TextSize) => void
  setMeasure: (m: Measure) => void
  echoKey: (k: string) => void

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

export type BodyFont = 'serif' | 'sans' | 'kai'
export type TextSize = 'auto' | 's' | 'm' | 'l' | 'xl'
export type Measure = 'normal' | 'wide' | 'full'

interface Prefs {
  sidebarOpen: boolean
  sidebarWidth: number
  theme: 'system' | 'light' | 'dark'
  bodyFont: BodyFont
  markdown: boolean
  textSize: TextSize
  measure: Measure
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

const project = () => useProjectStore.getState()

/** 段落写成 "## 标题" 时转为标题 */
const HEADING_SHORTCUT = /^(#{1,6})[ \t]+(\S[^\n]*)$/

/** from 与 to 之间（含两端）的块 id，按文档顺序 */
function idsBetween(fromId: string, toId: string): string[] {
  const blocks = project().data?.blocks ?? []
  const a = blocks.findIndex((b) => b.id === fromId)
  const b = blocks.findIndex((x) => x.id === toId)
  if (a < 0 || b < 0) return []
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return blocks.slice(lo, hi + 1).map((x) => x.id)
}

/**
 * 按当前选区推断 AI 作用范围。
 * 优先级：段内文字选区 > 多段选区 > 当前段落 / 标题。
 */
export function resolveScope(): AIScope | { error: string } | null {
  const data = project().data
  if (!data) return null
  const { textRange, selection, activeId } = useUIStore.getState()
  if (textRange && textRange.end > textRange.start) {
    const b = getBlock(data, textRange.blockId)
    if (b?.type === 'paragraph') {
      return {
        kind: 'range',
        blockIds: [b.id],
        range: [textRange.start, textRange.end],
        anchorId: b.id,
        label: '选中的文字',
        preview: b.text.slice(textRange.start, textRange.end),
      }
    }
  }
  if (selection && selection.ids.length > 1) {
    const blocks = selection.ids.map((id) => getBlock(data, id))
    if (blocks.some((b) => b?.type === 'heading')) {
      return { error: '选区跨越了章节标题，请分节处理' }
    }
    return {
      kind: 'paragraphs',
      blockIds: selection.ids,
      anchorId: selection.ids[selection.ids.length - 1],
      label: `选中的 ${selection.ids.length} 段`,
    }
  }
  const b = activeId ? getBlock(data, activeId) : undefined
  if (!b) return null
  if (b.type === 'paragraph') {
    return { kind: 'paragraphs', blockIds: [b.id], anchorId: b.id, label: isImageText(b.text) ? '这张图片' : '这一段' }
  }
  const body = sectionBodyIds(data.blocks, b.id)
  return {
    kind: 'section',
    blockIds: body,
    headingId: b.id,
    anchorId: b.id,
    label: body.length ? `本节「${b.text}」（${body.length} 段）` : `本节「${b.text}」（还没有正文）`,
  }
}

let toastSeq = 0
export const useUIStore = create<UIStore>((set, get) => ({
  activeId: null,
  selection: null,
  textRange: null,
  editing: null,
  aiPrompt: null,
  aiError: null,
  outlineProposal: null,
  stream: null,
  diff: null,
  sidebarOpen: loadPrefs().sidebarOpen ?? true,
  sidebarWidth: loadPrefs().sidebarWidth ?? 260,
  settingsOpen: false,
  helpOpen: false,
  briefOpen: false,
  agentOpen: false,
  publishOpen: false,
  versionPanelId: null,
  suggestionsOpen: false,
  flavorOpen: false,
  contextMenu: null,
  importOpen: false,
  locateRequest: null,
  theme: loadPrefs().theme ?? 'system',
  bodyFont: loadPrefs().bodyFont ?? 'serif',
  markdown: loadPrefs().markdown ?? true,
  textSize: loadPrefs().textSize ?? 'auto',
  measure: loadPrefs().measure ?? 'normal',
  toasts: [],
  keyEcho: null,

  setActive: (id) => {
    if (get().editing && get().editing?.id !== id) get().confirmEdit()
    set({ activeId: id, selection: null, aiPrompt: null, versionPanelId: null })
  },
  selectRange: (fromId, toId) => {
    const ids = idsBetween(fromId, toId)
    if (!ids.length) return
    if (get().editing) get().confirmEdit()
    set({
      selection: ids.length > 1 ? { anchorId: fromId, focusId: toId, ids } : null,
      activeId: toId,
      aiPrompt: null,
      versionPanelId: null,
    })
  },
  extendSelection: (dir) => {
    const { activeId, selection } = get()
    const blocks = project().data?.blocks ?? []
    if (!activeId) return
    const anchor = selection?.anchorId ?? activeId
    const focus = selection?.focusId ?? activeId
    const idx = blocks.findIndex((b) => b.id === focus) + dir
    if (idx < 0 || idx >= blocks.length) return
    get().selectRange(anchor, blocks[idx].id)
  },
  setTextRange: (range) => set({ textRange: range }),
  requestLocate: (id) =>
    set((s) => ({ locateRequest: { id, nonce: (s.locateRequest?.nonce ?? 0) + 1 } })),
  resetForDocument: () => {
    get().stream?.controller.abort()
    set({
      activeId: null,
      selection: null,
      textRange: null,
      editing: null,
      aiPrompt: null,
      aiError: null,
      stream: null,
      diff: null,
      versionPanelId: null,
      contextMenu: null,
      suggestionsOpen: false,
      flavorOpen: false,
      importOpen: false,
      briefOpen: false,
      agentOpen: false,
      publishOpen: false,
      outlineProposal: null,
      locateRequest: null,
    })
  },

  beginEdit: (id, caret) => {
    const b = project().data && getBlock(project().data!, id)
    if (!b) return
    const cur = get().editing
    // 已经在编辑这一块：只挪光标，绝不用存档文字覆盖正在写的草稿
    if (cur?.id === id) {
      if (caret !== undefined) set({ editing: { ...cur, caret, token: cur.token + 1 } })
      return
    }
    // 正在被 AI 生成 / 等待确认的段落不能同时编辑，否则结果会覆盖刚写的字
    const { stream, diff } = get()
    const busy = (p: Placement | null) => p != null && (p.blockIds.includes(id) || (!p.insert && p.anchorId === id))
    if (busy(stream) || busy(diff)) {
      get().pushToast({ kind: 'info', text: '这一段正在等 AI 的结果，先处理完再编辑' })
      return
    }
    if (cur) get().confirmEdit()
    set({
      editing: { id, draft: b.text, caret: caret ?? b.text.length, token: (cur?.token ?? 0) + 1 },
      activeId: id,
      aiPrompt: null,
      aiError: null,
    })
  },
  updateEditDraft: (draft) => set((s) => (s.editing ? { editing: { ...s.editing, draft } } : {})),
  confirmEdit: () => {
    const { editing } = get()
    const data = project().data
    if (!editing || !data) return
    set({ editing: null })
    const block = getBlock(data, editing.id)
    if (!block) return
    const draft = editing.draft
    // 清空的段落直接移除（至少保留一块，空白文稿才有地方落笔）
    if (block.type === 'paragraph' && !draft.trim() && data.blocks.length > 1) {
      project().removeBlock(editing.id)
      if (get().activeId === editing.id) set({ activeId: null })
      return
    }
    // Markdown 习惯：段落以 "## " 开头即转为对应层级的标题
    const heading = block.type === 'paragraph' ? HEADING_SHORTCUT.exec(draft.trim()) : null
    if (heading) {
      project().mutate((d) => {
        editBlock(d, editing.id, heading[2].trim())
        convertBlock(d, editing.id, 'heading', heading[1].length)
      })
      return
    }
    project().editBlock(editing.id, draft, 'manual')
  },
  cancelEdit: () => set({ editing: null }),

  splitAtCaret: (start, end) => {
    const { editing } = get()
    const data = project().data
    if (!editing || !data) return
    const block = getBlock(data, editing.id)
    if (!block) return
    const { draft } = editing
    const token = editing.token + 1

    // 标题里按回车：写入标题，在其后新起一段
    // 段落写成 "## 标题" 后按回车：同样先转成标题
    const heading = block.type === 'paragraph' ? HEADING_SHORTCUT.exec(draft.trim()) : null
    if (block.type === 'heading' || (heading && start === draft.length)) {
      let fresh: string | undefined
      project().mutate((d) => {
        if (heading) {
          editBlock(d, editing.id, heading[2].trim())
          convertBlock(d, editing.id, 'heading', heading[1].length)
        } else {
          editBlock(d, editing.id, draft)
        }
        fresh = insertParagraphAfter(d, editing.id)
      })
      if (fresh) set({ editing: { id: fresh, draft: '', caret: 0, token }, activeId: fresh })
      return
    }

    const merged = draft.slice(0, start) + draft.slice(end)
    let fresh: string | null | undefined
    project().mutate((d) => {
      editBlock(d, editing.id, merged)
      fresh = splitParagraph(d, editing.id, start)
    })
    const next = fresh && project().data ? getBlock(project().data!, fresh) : undefined
    if (next) set({ editing: { id: next.id, draft: next.text, caret: 0, token }, activeId: next.id })
  },

  mergeUpFromEdit: () => {
    const { editing } = get()
    const data = project().data
    if (!editing || !data) return false
    const idx = indexOfBlock(data, editing.id)
    const prev = data.blocks[idx - 1]
    const cur = data.blocks[idx]
    if (!prev || cur?.type !== 'paragraph') return false
    const token = editing.token + 1
    if (prev.type === 'paragraph') {
      let res: { id: string; caret: number } | null | undefined
      project().mutate((d) => {
        editBlock(d, editing.id, editing.draft)
        res = mergeWithPrevious(d, editing.id)
      })
      const merged = res && project().data ? getBlock(project().data!, res.id) : undefined
      if (!res || !merged) return false
      set({ editing: { id: merged.id, draft: merged.text, caret: res.caret, token }, activeId: merged.id })
      return true
    }
    // 上一块是标题：空段落直接删掉，光标回到标题末尾
    if (!editing.draft) {
      set({ editing: null })
      project().removeBlock(editing.id)
      set({ editing: { id: prev.id, draft: prev.text, caret: prev.text.length, token }, activeId: prev.id })
      return true
    }
    return false
  },

  mergeDownFromEdit: () => {
    const { editing } = get()
    const data = project().data
    if (!editing || !data) return false
    const idx = indexOfBlock(data, editing.id)
    const next = data.blocks[idx + 1]
    if (data.blocks[idx]?.type !== 'paragraph' || next?.type !== 'paragraph') return false
    const caret = editing.draft.length
    project().mutate((d) => {
      editBlock(d, editing.id, editing.draft)
      mergeWithPrevious(d, next.id)
    })
    const merged = project().data && getBlock(project().data!, editing.id)
    if (!merged) return false
    set({ editing: { id: merged.id, draft: merged.text, caret, token: editing.token + 1 } })
    return true
  },

  moveEdit: (dir) => {
    const { editing } = get()
    const data = project().data
    if (!editing || !data) return false
    const idx = indexOfBlock(data, editing.id)
    const neighbor = data.blocks[idx + dir]
    if (!neighbor) return false
    get().beginEdit(neighbor.id, dir < 0 ? neighbor.text.length : 0)
    return true
  },

  continueWriting: () => {
    const data = project().data
    if (!data) return
    const last = data.blocks[data.blocks.length - 1]
    if (last?.type === 'paragraph' && !last.text.trim()) {
      get().beginEdit(last.id)
      return
    }
    const fresh = project().insertParagraphAfter(last?.id ?? null)
    if (fresh) get().beginEdit(fresh)
  },

  openAIPrompt: (scope, draft = '') => {
    if (get().stream) {
      get().pushToast({ kind: 'info', text: '已有生成任务进行中' })
      return false
    }
    if (get().editing) get().confirmEdit()
    const resolved = scope ?? resolveScope()
    if (!resolved) return false
    if ('error' in resolved) {
      get().pushToast({ kind: 'info', text: resolved.error })
      return false
    }
    set({ aiPrompt: { scope: resolved, draft }, aiError: null, diff: null })
    return true
  },
  updatePromptDraft: (draft) =>
    set((s) => (s.aiPrompt ? { aiPrompt: { ...s.aiPrompt, draft } } : {})),
  closeAIPrompt: () => set({ aiPrompt: null, textRange: null }),
  setAIError: (error) => set({ aiError: error }),
  setOutlineProposal: (p) => set({ outlineProposal: p }),

  /* ── 对照确认 ───────────────────────────────────── */

  openDiff: (suggestionId) => {
    // 正在编辑的草稿先写入，不能因为结果弹出来就丢掉
    if (get().editing) get().confirmEdit()
    const data = project().data
    const sg = data?.suggestions.find((s) => s.id === suggestionId)
    if (!sg || sg.kind !== 'ai_diff' || sg.state !== 'pending') return
    const count = Math.max(1, clusterize(sg.diff).length)
    const insert = sg.target.blockIds.length === 0
    const whole = insert || changeRatio(sg.diff) > WHOLE_REWRITE_RATIO
    set({
      diff: {
        suggestionId,
        decisions: new Array(count).fill(undefined),
        focused: 0,
        anchorId: insert ? sg.target.insertAfter ?? null : sg.target.blockIds[0],
        blockIds: sg.target.blockIds,
        insert,
        whole,
        view: whole ? 'result' : 'marked',
      },
      editing: null,
      aiPrompt: null,
      aiError: null,
      activeId: insert ? get().activeId : sg.target.blockIds[0],
    })
  },
  closeDiff: () => set({ diff: null }),
  setDecision: (index, accepted) =>
    set((s) => {
      if (!s.diff || s.diff.whole) return {}
      const decisions = [...s.diff.decisions]
      decisions[index] = accepted
      const nextOpen = decisions.findIndex((d) => d === undefined)
      return { diff: { ...s.diff, decisions, focused: nextOpen >= 0 ? nextOpen : s.diff.focused } }
    }),
  focusCluster: (index) => set((s) => (s.diff ? { diff: { ...s.diff, focused: index } } : {})),
  setDiffView: (view) =>
    set((s) => (s.diff ? { diff: { ...s.diff, view: s.diff.whole && view === 'marked' ? 'result' : view } } : {})),
  acceptDiff: () => {
    const { diff } = get()
    const data = project().data
    const sg = data?.suggestions.find((s) => s.id === diff?.suggestionId)
    set({ diff: null })
    if (!diff || !sg || sg.state !== 'pending') return null
    if (diff.decisions.length && diff.decisions.every((d) => d === false)) {
      project().dismissSuggestion(sg.id)
      return null
    }
    const ids = project().applySuggestion(sg.id, applyDecisions(sg.diff, diff.decisions))
    if (!ids) {
      project().dismissSuggestion(sg.id)
      get().pushToast({ kind: 'error', text: '原文在生成后被改动过，这条修改已作废' })
      return null
    }
    if (ids.length) set({ activeId: ids[0] })
    return ids
  },
  rejectDiff: () => {
    const { diff } = get()
    if (!diff) return
    set({ diff: null })
    project().dismissSuggestion(diff.suggestionId)
  },
  acceptAndEdit: () => {
    const ids = get().acceptDiff()
    if (ids?.length) get().beginEdit(ids[0])
  },
  switchCandidate: (delta) => {
    const { diff } = get()
    const sg = project().data?.suggestions.find((s) => s.id === diff?.suggestionId)
    const list = sg?.candidates ?? []
    if (!diff || !sg || list.length < 2) return
    const idx = Math.max(0, list.indexOf(sg.proposed))
    const next = list[(idx + delta + list.length) % list.length]
    project().setSuggestionProposed(sg.id, next)
    get().openDiff(sg.id)
  },

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
  setBriefOpen: (open) => set({ briefOpen: open }),
  setAgentOpen: (open) => set({ agentOpen: open }),
  setPublishOpen: (open) => set({ publishOpen: open }),
  setVersionPanelId: (id) => set({ versionPanelId: id }),
  setSuggestionsOpen: (open) => set(open ? { suggestionsOpen: true, flavorOpen: false } : { suggestionsOpen: false }),
  setFlavorOpen: (open) => set(open ? { flavorOpen: true, suggestionsOpen: false } : { flavorOpen: false }),
  setContextMenu: (menu) => set({ contextMenu: menu }),
  setImportOpen: (open) => set({ importOpen: open }),
  setTheme: (t) => {
    savePrefs({ theme: t })
    set({ theme: t })
    applyTheme(t, true)
  },
  setMarkdown: (on) => {
    savePrefs({ markdown: on })
    set({ markdown: on })
  },
  setBodyFont: (f) => {
    savePrefs({ bodyFont: f })
    set({ bodyFont: f })
    applyTypography()
  },
  setTextSize: (t) => {
    savePrefs({ textSize: t })
    set({ textSize: t })
    applyTypography()
  },
  setMeasure: (m) => {
    savePrefs({ measure: m })
    set({ measure: m })
    applyTypography()
  },
  echoKey: (k) => {
    window.clearTimeout(echoTimer)
    echoTimer = window.setTimeout(() => {
      useUIStore.setState({ keyEcho: null })
    }, 140)
    set({ keyEcho: k.toLowerCase() })
  },

  pushToast: (t) => {
    const id = `t_${++toastSeq}`
    // 错误要留足时间读完（也可以手动关）；普通提示 2.4 秒
    const duration = t.duration ?? (t.kind === 'error' ? 8000 : 2400)
    set((s) => ({ toasts: [...s.toasts, { ...t, id, duration }].slice(-3) }))
    if (duration > 0) setTimeout(() => get().dismissToast(id), duration)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/* ── 内部工具 ────────────────────────────────────────── */

let themeTimer = 0

/** 正文字体、字号、列宽写到 <html> 的 data-* 上，由 tokens.css 换算成变量；取默认值时去掉属性 */
export function applyTypography(): void {
  const { bodyFont, textSize, measure } = useUIStore.getState()
  const root = document.documentElement
  const put = (name: string, v: string, fallback: string) =>
    v === fallback ? root.removeAttribute(name) : root.setAttribute(name, v)
  put('data-font', bodyFont, 'serif')
  put('data-text-size', textSize, 'auto')
  put('data-measure', measure, 'normal')
}

/** 应用主题。animate=true 时开启 .theme-transitioning 窗口做 200ms 色彩过渡。 */
export function applyTheme(t: 'system' | 'light' | 'dark', animate = true): void {
  const dark =
    t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  const next = dark ? 'dark' : 'light'
  const root = document.documentElement
  if (root.getAttribute('data-theme') === next) return
  if (animate) {
    root.classList.add('theme-transitioning')
    window.clearTimeout(themeTimer)
    themeTimer = window.setTimeout(() => root.classList.remove('theme-transitioning'), 260)
  }
  root.setAttribute('data-theme', next)
}

let echoTimer = 0


/**
 * 文稿变化（撤销 / 重做 / 外部载入）后，清理已经失效的界面状态：
 * 对照的建议不再待确认、选中或编辑的块已不存在、指令框的范围已消失。
 */
useProjectStore.subscribe((s, prev) => {
  if (s.data === prev.data) return
  const ui = useUIStore.getState()
  const data = s.data
  const has = (id: string | null | undefined) => !!id && !!data?.blocks.some((b) => b.id === id)
  const patch: Partial<ReturnType<typeof useUIStore.getState>> = {}
  if (ui.diff) {
    const sg = data?.suggestions.find((x) => x.id === ui.diff!.suggestionId)
    if (!sg || sg.state !== 'pending') patch.diff = null
  }
  if (ui.editing && !has(ui.editing.id)) patch.editing = null
  if (ui.activeId && !has(ui.activeId)) patch.activeId = null
  if (ui.selection && !ui.selection.ids.every(has)) patch.selection = null
  if (ui.textRange && !has(ui.textRange.blockId)) patch.textRange = null
  if (ui.aiPrompt && !ui.aiPrompt.scope.blockIds.every(has)) patch.aiPrompt = null
  if (ui.aiError && !has(ui.aiError.anchorId)) patch.aiError = null
  if (Object.keys(patch).length) useUIStore.setState(patch)
})

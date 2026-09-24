/**
 * 文稿仓库：当前文稿 + 撤销 / 重做。
 * 所有修改走 mutate：在 immer 草稿上调用 lib/doc 的纯函数，内容没变就不记历史。
 */
import { create } from 'zustand'
import { produce } from 'immer'
import type { AgentAccess, ProjectData, VersionSource } from '../types'
import * as doc from '../lib/doc'
import * as tasks from '../lib/tasks'

const HISTORY_LIMIT = 100

export interface ProjectStore {
  data: ProjectData | null
  past: ProjectData[]
  future: ProjectData[]
  /** 内容每变化一次 +1，自动保存据此判断（切换文稿不算变化） */
  revision: number

  /** 切换到另一篇文稿（null 表示关闭）；撤销历史按文稿独立 */
  setDocument: (data: ProjectData | null) => void

  /* 历史 */
  undo: () => void
  redo: () => void

  /** 通用修改入口：recipe 的返回值透传；内容未变时不记历史 */
  mutate: <R>(recipe: (d: ProjectData) => R) => R | undefined

  /* 常用操作（mutate 的具名包装） */
  editBlock: (id: string, text: string, source?: VersionSource, instruction?: string | null) => boolean
  splitParagraph: (id: string, offset: number) => string | null
  mergeWithPrevious: (id: string) => { id: string; caret: number } | null
  insertParagraphAfter: (afterId: string | null, text?: string) => string | null
  insertHeadingAfter: (afterId: string | null, level: number, text: string) => string | null
  removeBlock: (id: string) => void
  convertBlock: (id: string, to: 'heading' | 'paragraph', level?: number) => void
  rollback: (id: string, versionIndex: number) => boolean
  moveSection: (headingId: string, targetId: string, position: 'before' | 'after' | 'inside') => boolean
  shiftSectionLevel: (headingId: string, delta: number) => boolean
  addSuggestion: (input: doc.NewSuggestion) => string | null
  setSuggestionProposed: (id: string, proposed: string) => void
  applySuggestion: (id: string, finalText: string) => string[] | null
  dismissSuggestion: (id: string) => void

  acceptChangeset: (changeset: string) => { applied: number; stale: number }
  rejectChangeset: (changeset: string) => number
  /** 外部程序（如 agent）改了文件：整体替换，进撤销历史，Ctrl+Z 可回到替换前 */
  replaceFromExternal: (data: ProjectData) => void

  /* 交给 Agent 的任务 */
  addTask: (input: tasks.NewTask) => string | null
  cancelTask: (id: string) => void
  removeTask: (id: string) => void

  /* 元信息（不进撤销历史） */
  renameTitle: (title: string) => void
  setBrief: (brief: string) => void
  /** agent 权限只由作者在这里设定，不进撤销历史 */
  setAgentAccess: (access: AgentAccess) => void
}

export const useProjectStore = create<ProjectStore>()((set, get) => {
  const mutate = <R>(recipe: (d: ProjectData) => R): R | undefined => {
    const cur = get().data
    if (!cur) return undefined
    let result: R | undefined
    const next = produce(cur, (draft) => {
      result = recipe(draft as ProjectData)
    })
    if (next !== cur) {
      set((s) => ({
        data: next,
        past: [...s.past, cur].slice(-HISTORY_LIMIT),
        future: [],
        revision: s.revision + 1,
      }))
    }
    return result
  }

  return {
    data: null,
    past: [],
    future: [],
    revision: 0,

    setDocument: (data) => set({ data, past: [], future: [] }),

    undo: () =>
      set((s) => {
        if (!s.past.length) return {}
        const prev = s.past[s.past.length - 1]
        return {
          data: prev,
          past: s.past.slice(0, -1),
          future: s.data ? [...s.future, s.data] : s.future,
          revision: s.revision + 1,
        }
      }),

    redo: () =>
      set((s) => {
        if (!s.future.length) return {}
        const next = s.future[s.future.length - 1]
        return {
          data: next,
          future: s.future.slice(0, -1),
          past: s.data ? [...s.past, s.data] : s.past,
          revision: s.revision + 1,
        }
      }),

    mutate,

    editBlock: (id, text, source, instruction) =>
      mutate((d) => doc.editBlock(d, id, text, source, instruction ?? null)) ?? false,
    splitParagraph: (id, offset) => mutate((d) => doc.splitParagraph(d, id, offset)) ?? null,
    mergeWithPrevious: (id) => mutate((d) => doc.mergeWithPrevious(d, id)) ?? null,
    insertParagraphAfter: (afterId, text) =>
      mutate((d) => doc.insertParagraphAfter(d, afterId, text)) ?? null,
    insertHeadingAfter: (afterId, level, text) =>
      mutate((d) => doc.insertHeadingAfter(d, afterId, level, text)) ?? null,
    removeBlock: (id) => void mutate((d) => doc.removeBlock(d, id)),
    convertBlock: (id, to, level) => void mutate((d) => doc.convertBlock(d, id, to, level)),
    rollback: (id, index) => mutate((d) => doc.rollback(d, id, index)) ?? false,
    moveSection: (headingId, targetId, position) =>
      mutate((d) => doc.moveSection(d, headingId, targetId, position)) ?? false,
    shiftSectionLevel: (headingId, delta) =>
      mutate((d) => doc.shiftSectionLevel(d, headingId, delta)) ?? false,
    addSuggestion: (input) => mutate((d) => doc.addSuggestion(d, input)) ?? null,
    setSuggestionProposed: (id, proposed) =>
      void mutate((d) => doc.setSuggestionProposed(d, id, proposed)),
    applySuggestion: (id, finalText) => mutate((d) => doc.applySuggestion(d, id, finalText)) ?? null,
    dismissSuggestion: (id) => void mutate((d) => doc.dismissSuggestion(d, id)),

    acceptChangeset: (changeset) =>
      mutate((d) => doc.acceptChangeset(d, changeset)) ?? { applied: 0, stale: 0 },
    rejectChangeset: (changeset) => mutate((d) => doc.rejectChangeset(d, changeset)) ?? 0,
    replaceFromExternal: (next) =>
      set((s) => ({
        data: next,
        past: s.data ? [...s.past, s.data].slice(-HISTORY_LIMIT) : s.past,
        future: [],
        revision: s.revision + 1,
      })),

    addTask: (input) => mutate((d) => tasks.createTask(d, input)) ?? null,
    cancelTask: (id) => void mutate((d) => tasks.cancelTask(d, id)),
    removeTask: (id) => void mutate((d) => tasks.removeTask(d, id)),

    setAgentAccess: (access) =>
      set((s) =>
        s.data
          ? { data: { ...s.data, meta: { ...s.data.meta, agentAccess: access } }, revision: s.revision + 1 }
          : {}
      ),

    renameTitle: (title) =>
      set((s) =>
        s.data
          ? {
              // 明确起过标题，导出 Markdown 时就写成文首一级标题
              data: { ...s.data, meta: { ...s.data.meta, title, titleAsHeading: true } },
              revision: s.revision + 1,
            }
          : {}
      ),

    setBrief: (brief) =>
      set((s) =>
        s.data ? { data: { ...s.data, brief }, revision: s.revision + 1 } : {}
      ),
  }
})

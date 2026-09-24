/**
 * 工程状态仓库（Zustand + Immer）。
 * 块级细粒度更新 + 撤销/重做快照（spec §7）。
 * 所有组级操作通过 key 解析底层块：
 *   'p:<paragraphId>' 段落组 | 's:<blockId>' 句子块 | 'full' 全文
 */
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  Block,
  Granularity,
  ProjectData,
  Suggestion,
  Version,
  VersionSource,
} from '../types'
import { nowISO, uid } from '../lib/ids'
import { applyDecisions, computeDiff } from '../lib/diff'
import {
  getGroupBlocks,
  parseProjectJson,
  resegmentText,
} from '../lib/project'
import { parseDocument } from '../lib/importer'

const HISTORY_LIMIT = 100

export interface ProjectStore {
  data: ProjectData | null
  past: ProjectData[]
  future: ProjectData[]
  /** 自上次自动保存以来是否有改动 */
  unsaved: boolean
  lastSavedAt: string | null

  /* 生命周期 */
  createEmpty: (title?: string) => void
  importText: (
    text: string,
    title?: string
  ) => { truncated: boolean; title: string }
  loadJson: (text: string) => void
  clear: () => void

  /* 历史 */
  capture: () => void
  undo: () => void
  redo: () => void

  /* 块操作 */
  applyGroupEdit: (
    key: string,
    patch: { text: string; source: VersionSource; instruction?: string | null }
  ) => string[] /* 返回新块 id，便于 UI 重新定位 */
  mergeWithPrevious: (key: string, prevKey: string) => string[]
  splitAt: (key: string, cursorIndex: number | null) => string[]
  attachToNode: (key: string, nodeId: string | null) => void
  rollback: (key: string, versionIndex: number) => string[]
  setBlockDirty: (key: string) => void

  /* 建议 */
  createSuggestion: (patch: {
    blockKey: string
    proposed: string
    instruction?: string | null
    scope?: Suggestion['scope']
  }) => string
  /** 扩写空章节：新建挂靠块 + diff 建议 */
  createExpandSuggestion: (patch: {
    nodeId: string
    proposed: string
    instruction: string | null
  }) => string
  /** diff 逐处确认后落盘：接受处取新文、拒绝处取原文 */
  applySuggestionDecision: (id: string, decisions: boolean[]) => void
  dismissSuggestion: (id: string) => void

  /* 大纲 */
  addOutlineNode: (patch: {
    parentId: string | null
    siblingId: string | null
    title: string
  }) => string
  renameOutlineNode: (id: string, title: string) => void
  deleteOutlineNode: (id: string) => void

  /* 元信息 */
  updateSettings: (patch: Partial<ProjectData['settings']>) => void
  renameTitle: (title: string) => void
  markSaved: () => void
}

type Draft = ProjectData

function emptyProject(title = '未命名文稿'): Draft {
  return {
    schema: 'ai-writer/project@1',
    meta: {
      title,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      language: 'zh',
    },
    settings: {
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      temperature: 0.7,
    },
    outline: [],
    blocks: [],
    suggestions: [],
  }
}

/** 把整组底层块替换为重新切分的新块，并写入版本历史 */
function replaceGroup(
  state: ProjectData,
  groupBlocks: Block[],
  newText: string,
  source: VersionSource,
  instruction: string | null,
  newParagraphId?: string
): string[] {
  if (!groupBlocks.length) return []
  const first = groupBlocks[0]
  const idx = state.blocks.findIndex((b) => b.id === first.id)
  const history = first.versions
  const nextVersion: Version = {
    v: (history[history.length - 1]?.v ?? 0) + 1,
    text: newText,
    source,
    instruction,
    at: nowISO(),
  }
  const versions = [...history, nextVersion]
  const segments = resegmentText(
    newText,
    {
      paragraphId: newParagraphId ?? first.paragraphId,
      outlineNodeId: first.outlineNodeId,
    },
    idx
  )
  // 手动编辑在自动保存前保持 dirty（design §5.3：右上角小圆点）
  const status: Block['status'] = source === 'manual' ? 'dirty' : 'clean'
  const newBlocks: Block[] = segments.map((s) => ({ ...s, versions, status }))
  state.blocks.splice(idx, groupBlocks.length, ...newBlocks)
  return newBlocks.map((b) => b.id)
}

function findNodeById(
  nodes: ProjectData['outline'],
  id: string
): ProjectData['outline'][number] | null {
  for (const n of nodes) {
    if (n.id === id) return n
    const found = findNodeById(n.children, id)
    if (found) return found
  }
  return null
}

function removeNodeById(
  nodes: ProjectData['outline'],
  id: string
): ProjectData['outline'] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => ({ ...n, children: removeNodeById(n.children, id) }))
}

export const useProjectStore = create<ProjectStore>()(
  immer((set, get) => ({
    data: null,
    past: [],
    future: [],
    unsaved: false,
    lastSavedAt: null,

    createEmpty: (title) =>
      set((s) => {
        s.data = emptyProject(title)
        s.past = []
        s.future = []
        s.unsaved = false
      }),

    importText: (text, title) => {
      const parsed = parseDocument(text)
      set((s) => {
        s.past.push(s.data ?? emptyProject())
        if (s.past.length > HISTORY_LIMIT) s.past.shift()
        s.future = []
        s.data = {
          ...emptyProject(title ?? parsed.title),
          outline: parsed.outline,
          blocks: parsed.blocks.map((b) => ({ ...b })),
        }
        s.unsaved = true
      })
      return { truncated: parsed.truncated, title: title ?? parsed.title }
    },

    loadJson: (text) => {
      const parsed = parseProjectJson(text)
      set((s) => {
        s.past.push(s.data ?? emptyProject())
        if (s.past.length > HISTORY_LIMIT) s.past.shift()
        s.future = []
        s.data = parsed
        s.unsaved = false
      })
    },

    clear: () =>
      set((s) => {
        s.data = null
        s.past = []
        s.future = []
        s.unsaved = false
      }),

    capture: () =>
      set((s) => {
        if (!s.data) return
        // 快照规则：入栈与改写必须在两个独立配方里。同一配方内 push 的是
        // draft 代理，后续对 s.data 的改写会污染历史快照（撤销失效）。
        s.past.push(s.data)
        if (s.past.length > HISTORY_LIMIT) s.past.shift()
        s.future = []
        s.unsaved = true
      }),

    undo: () =>
      set((s) => {
        if (!s.past.length) return
        const prev = s.past.pop()!
        if (s.data) s.future.push(s.data)
        s.data = prev
        s.unsaved = true
      }),

    redo: () =>
      set((s) => {
        if (!s.future.length) return
        const next = s.future.pop()!
        if (s.data) s.past.push(s.data)
        s.data = next
        s.unsaved = true
      }),

    applyGroupEdit: (key, patch) => {
      let newIds: string[] = []
      get().capture() // 先落定快照，再改写
      set((s) => {
        if (!s.data) return
        const group = getGroupBlocks(s.data, key)
        newIds = replaceGroup(
          s.data,
          group,
          patch.text,
          patch.source,
          patch.instruction ?? null
        )
      })
      return newIds
    },

    mergeWithPrevious: (key, prevKey) => {
      const data = get().data
      if (!data) return []
      const group = getGroupBlocks(data, key)
      const prevGroup = getGroupBlocks(data, prevKey)
      if (!group.length || !prevGroup.length) return []
      let newIds: string[] = []
      get().capture()
      set((s) => {
        if (!s.data) return
        const idx = s.data.blocks.findIndex((b) => b.id === prevGroup[0].id)
        const mergedText = [...prevGroup, ...group].map((b) => b.text).join('')
        const history = prevGroup[0].versions
        const version: Version = {
          v: (history[history.length - 1]?.v ?? 0) + 1,
          text: mergedText,
          source: 'merge',
          instruction: null,
          at: nowISO(),
        }
        const segments = resegmentText(
          mergedText,
          {
            paragraphId: prevGroup[0].paragraphId,
            outlineNodeId: prevGroup[0].outlineNodeId,
          },
          idx
        )
        s.data.blocks.splice(
          idx,
          prevGroup.length + group.length,
          ...segments.map((seg) => ({ ...seg, versions: [...history, version] }))
        )
        newIds = segments.map((b) => b.id)
      })
      return newIds
    },

    splitAt: (key, cursorIndex) => {
      const data = get().data
      if (!data) return []
      const group = getGroupBlocks(data, key)
      const text = group.map((b) => b.text).join('')
      const cut =
        cursorIndex != null
          ? cursorIndex
          : nearestSentenceCut(text, text.length / 2)
      if (cut <= 0 || cut >= text.length) return []
      // 句子粒度拆分：左右仍属同一段落；段落/全文粒度拆分：右半获得新段落 id
      const breakParagraph = !key.startsWith('s:')
      let newIds: string[] = []
      get().capture()
      set((s) => {
        if (!s.data) return
        const first = group[0]
        const idx = s.data.blocks.findIndex((b) => b.id === first.id)
        const history = first.versions
        const mkVersion = (t: string): Version => ({
          v: (history[history.length - 1]?.v ?? 0) + 1,
          text: t,
          source: 'split',
          instruction: null,
          at: nowISO(),
        })
        const leftText = text.slice(0, cut)
        const rightText = text.slice(cut)
        const leftSegs = resegmentText(
          leftText,
          { paragraphId: first.paragraphId, outlineNodeId: first.outlineNodeId },
          idx
        )
        const rightSegs = resegmentText(
          rightText,
          {
            paragraphId: breakParagraph ? uid('p') : first.paragraphId,
            outlineNodeId: first.outlineNodeId,
          },
          idx + leftSegs.length
        )
        const newBlocks: Block[] = [
          ...leftSegs.map((seg) => ({ ...seg, versions: [...history, mkVersion(leftText)] })),
          ...rightSegs.map((seg) => ({ ...seg, versions: [...history, mkVersion(rightText)] })),
        ]
        s.data.blocks.splice(idx, group.length, ...newBlocks)
        newIds = newBlocks.map((b) => b.id)
      })
      return newIds
    },

    attachToNode: (key, nodeId) => {
      get().capture()
      set((s) => {
        if (!s.data) return
        for (const b of getGroupBlocks(s.data, key)) b.outlineNodeId = nodeId
      })
    },

    rollback: (key, versionIndex) => {
      const data = get().data
      if (!data) return []
      const group = getGroupBlocks(data, key)
      const versions = group[0].versions
      const target = versions[versionIndex]
      if (!target) return []
      let newIds: string[] = []
      get().capture()
      set((s) => {
        if (!s.data) return
        newIds = replaceGroup(s.data, group, target.text, 'manual', null)
      })
      return newIds
    },

    setBlockDirty: (key) =>
      set((s) => {
        if (!s.data) return
        for (const b of getGroupBlocks(s.data, key)) b.status = 'dirty'
        s.unsaved = true
      }),

    createSuggestion: ({ blockKey, proposed, instruction, scope }) => {
      const data = get().data
      if (!data) return ''
      const group = getGroupBlocks(data, blockKey)
      if (!group.length) return ''
      const oldText = group.map((b) => b.text).join('')
      const diff = computeDiff(oldText, proposed)
      const id = uid('s')
      const suggestion: Suggestion = {
        id,
        blockId: group[0].id,
        kind: 'ai_diff',
        instruction: instruction ?? null,
        proposed,
        diff,
        state: 'pending',
        createdAt: nowISO(),
        scope: scope ?? 'paragraph',
      }
      get().capture()
      set((s) => {
        if (!s.data) return
        // 同组已有的待确认 diff 直接作废（重试场景）
        const groupIds = new Set(group.map((b) => b.id))
        for (const old of s.data.suggestions) {
          if (old.state === 'pending' && groupIds.has(old.blockId)) old.state = 'rejected'
        }
        s.data.suggestions.push(suggestion)
      })
      return id
    },

    dismissSuggestion: (id) => {
      get().capture()
      set((s) => {
        if (!s.data) return
        const target = s.data.suggestions.find((x) => x.id === id)
        if (target) target.state = 'rejected'
      })
    },

    /** 扩写空章节：在节点末尾新建空块，并挂上全新增的 diff 建议 */
    createExpandSuggestion: ({ nodeId, proposed, instruction }) => {
      const data = get().data
      if (!data) return ''
      const blockId = uid('b')
      const paragraphId = uid('p')
      const at = nowISO()
      const suggestion: Suggestion = {
        id: uid('s'),
        blockId,
        kind: 'ai_diff',
        instruction,
        proposed,
        diff: computeDiff('', proposed),
        state: 'pending',
        createdAt: at,
        scope: 'sentence',
      }
      get().capture()
      set((s) => {
        if (!s.data) return
        // 插到同节点最后一块之后
        let insertAt = s.data.blocks.length
        for (let i = s.data.blocks.length - 1; i >= 0; i--) {
          if (s.data.blocks[i].outlineNodeId === nodeId) {
            insertAt = i + 1
            break
          }
          if (s.data.blocks[i].outlineNodeId === null) insertAt = i + 1
        }
        s.data.blocks.splice(insertAt, 0, {
          id: blockId,
          outlineNodeId: nodeId,
          order: insertAt,
          text: '',
          status: 'clean',
          versions: [
            { v: 0, text: '', source: 'import', instruction: null, at },
          ],
          paragraphId,
        })
        s.data.suggestions.push(suggestion)
      })
      return suggestion.id
    },

    /** diff 逐处确认落盘：全拒则原样保留，全收/混合则写入对应版本 */
    applySuggestionDecision: (id, decisions) => {
      const data = get().data
      if (!data) return
      const sg = data.suggestions.find((s) => s.id === id)
      if (!sg || sg.state !== 'pending') return
      const key =
        sg.scope === 'full'
          ? 'full'
          : sg.scope === 'sentence'
            ? `s:${sg.blockId}`
            : `p:${resolveParagraphOf(data, sg.blockId)}`
      get().capture()
      set((s) => {
        if (!s.data) return
        const target = s.data.suggestions.find((x) => x.id === id)!
        const finalText = applyDecisions(target.diff, decisions)
        const allRejected = decisions.every((d) => d === false)
        target.state = allRejected ? 'rejected' : 'accepted'
        if (allRejected || finalText === '') return
        const group = getGroupBlocks(s.data, key)
        if (!group.length) return
        replaceGroup(
          s.data,
          group,
          finalText,
          target.instruction ? 'ai_revise' : 'ai_rewrite',
          target.instruction
        )
      })
    },

    addOutlineNode: ({ parentId, siblingId, title }) => {
      const id = uid('on')
      get().capture()
      set((s) => {
        if (!s.data) return
        const node = { id, title, children: [] }
        if (parentId) {
          const parent = findNodeById(s.data.outline, parentId)
          if (parent) parent.children.push(node)
          else s.data.outline.push(node)
        } else if (siblingId) {
          insertSibling(s.data.outline, siblingId, node)
        } else {
          s.data.outline.push(node)
        }
      })
      return id
    },

    renameOutlineNode: (id, title) => {
      get().capture()
      set((s) => {
        if (!s.data) return
        const node = findNodeById(s.data.outline, id)
        if (node) node.title = title
      })
    },

    deleteOutlineNode: (id) => {
      get().capture()
      set((s) => {
        if (!s.data) return
        s.data.outline = removeNodeById(s.data.outline, id)
        // 节点删除后，其下块变为未挂靠
        for (const b of s.data.blocks) {
          if (b.outlineNodeId === id) b.outlineNodeId = null
        }
      })
    },

    updateSettings: (patch) =>
      set((s) => {
        if (!s.data) return
        Object.assign(s.data.settings, patch)
        s.unsaved = true
      }),

    renameTitle: (title) =>
      set((s) => {
        if (!s.data) return
        s.data.meta.title = title
        s.unsaved = true
      }),

    markSaved: () =>
      set((s) => {
        s.unsaved = false
        s.lastSavedAt = nowISO()
        // 自动保存落盘后清除 dirty 标记（design §5.3）
        if (s.data) {
          for (const b of s.data.blocks) {
            if (b.status === 'dirty') b.status = 'clean'
          }
        }
      }),
  }))
)

function resolveParagraphOf(data: ProjectData, blockId: string): string {
  const b = data.blocks.find((x) => x.id === blockId)
  return b ? b.paragraphId : ''
}

function insertSibling(
  nodes: ProjectData['outline'],
  siblingId: string,
  node: ProjectData['outline'][number]
): void {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === siblingId) {
      nodes.splice(i + 1, 0, node)
      return
    }
    insertSibling(nodes[i].children, siblingId, node)
  }
}

/** 找最接近目标位置的句子边界 */
export function nearestSentenceCut(text: string, target: number): number {
  let best = -1
  let bestDist = Infinity
  const re = /[。！？；…!?]\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const cut = m.index + m[0].length
    const dist = Math.abs(cut - target)
    if (dist < bestDist) {
      bestDist = dist
      best = cut
    }
  }
  if (best < 0) best = Math.floor(text.length / 2)
  return best
}

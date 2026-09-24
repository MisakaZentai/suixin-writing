/**
 * 文档操作库：全部是对 ProjectData 的原地修改（在 immer 草稿上调用），
 * 不依赖 React / store，便于单元测试。
 */
import type {
  DocBlock,
  HeadingBlock,
  OutlineNode,
  ParagraphBlock,
  ProjectData,
  Suggestion,
  SuggestionTarget,
  VersionSource,
} from '../types'
import { computeDiff } from './diff'
import { nowISO, uid } from './ids'
import { clampLevel, makeHeading, makeParagraph } from './markdown'
import { isImageText } from './images'

/* ── 基础查询 ─────────────────────────────────────── */

export function indexOfBlock(d: ProjectData, id: string): number {
  return d.blocks.findIndex((b) => b.id === id)
}

export function getBlock(d: ProjectData, id: string): DocBlock | undefined {
  return d.blocks.find((b) => b.id === id)
}

/** 字数：不计空白的字符数（中文写作的通行算法） */
export function countChars(text: string): number {
  // 图片段落不计字数
  if (isImageText(text)) return 0
  return text.replace(/\s/g, '').length
}

export function pushVersion(
  block: DocBlock,
  text: string,
  source: VersionSource,
  instruction: string | null = null,
  author?: string
): void {
  const last = block.versions[block.versions.length - 1]
  block.versions.push({
    v: (last?.v ?? -1) + 1,
    text,
    source,
    instruction,
    at: nowISO(),
    ...(author ? { author } : {}),
  })
}

/* ── 块编辑 ───────────────────────────────────────── */

/** 改写一个块的文本；文本未变时不产生版本，返回 false */
export function editBlock(
  d: ProjectData,
  id: string,
  text: string,
  source: VersionSource = 'manual',
  instruction: string | null = null,
  author?: string
): boolean {
  const b = getBlock(d, id)
  if (!b) return false
  const next = b.type === 'heading' ? text.replace(/\s*\n\s*/g, ' ').trim() : text
  if (next === b.text) return false
  b.text = next
  pushVersion(b, next, source, instruction, author)
  return true
}

/**
 * 在 offset 处把段落一分为二：前半留在原段（保留历史），后半成为新段落。
 * 返回新段落 id。
 */
export function splitParagraph(d: ProjectData, id: string, offset: number): string | null {
  const idx = indexOfBlock(d, id)
  const b = d.blocks[idx]
  // 图片段落不拆
  if (!b || b.type !== 'paragraph' || isImageText(b.text)) return null
  const cut = Math.max(0, Math.min(offset, b.text.length))
  const left = b.text.slice(0, cut).replace(/[ \t\n]+$/, '')
  const right = b.text.slice(cut).replace(/^[ \t\n]+/, '')
  if (left !== b.text) {
    b.text = left
    pushVersion(b, left, 'split')
  }
  const fresh = makeParagraph(right, 'split')
  d.blocks.splice(idx + 1, 0, fresh)
  return fresh.id
}

/**
 * 与上一段合并（上一块必须也是段落）。返回合并后的段落 id 与接缝处的光标位置。
 */
export function mergeWithPrevious(
  d: ProjectData,
  id: string
): { id: string; caret: number } | null {
  const idx = indexOfBlock(d, id)
  if (idx <= 0) return null
  const prev = d.blocks[idx - 1]
  const cur = d.blocks[idx]
  if (prev.type !== 'paragraph' || cur.type !== 'paragraph') return null
  // 图片不和文字并成一段
  if (isImageText(prev.text) || isImageText(cur.text)) return null
  const caret = prev.text.length
  const needsSpace = /[A-Za-z0-9,.;:!?]$/.test(prev.text) && /^[A-Za-z0-9]/.test(cur.text)
  const joined = prev.text + (needsSpace ? ' ' : '') + cur.text
  if (joined !== prev.text) {
    prev.text = joined
    pushVersion(prev, joined, 'merge')
  }
  d.blocks.splice(idx, 1)
  dropSuggestionsFor(d, [cur.id])
  return { id: prev.id, caret }
}

/** 在 afterId 之后插入段落（afterId 为 null 时插到文首），返回新 id */
export function insertParagraphAfter(
  d: ProjectData,
  afterId: string | null,
  text = ''
): string {
  const fresh = makeParagraph(text, 'manual')
  const idx = afterId ? indexOfBlock(d, afterId) : -1
  d.blocks.splice(idx + 1, 0, fresh)
  return fresh.id
}

export function insertHeadingAfter(
  d: ProjectData,
  afterId: string | null,
  level: number,
  text: string
): string {
  const fresh = makeHeading(level, text, 'manual')
  const idx = afterId ? indexOfBlock(d, afterId) : -1
  d.blocks.splice(idx + 1, 0, fresh)
  return fresh.id
}

export function removeBlock(d: ProjectData, id: string): boolean {
  const idx = indexOfBlock(d, id)
  if (idx < 0) return false
  d.blocks.splice(idx, 1)
  dropSuggestionsFor(d, [id])
  return true
}

/** 段落 ↔ 标题互转，保留 id 与版本历史 */
export function convertBlock(
  d: ProjectData,
  id: string,
  to: 'heading' | 'paragraph',
  level = 2
): boolean {
  const idx = indexOfBlock(d, id)
  const b = d.blocks[idx]
  if (!b) return false
  if (to === 'heading') {
    if (isImageText(b.text)) return false
    const text = b.text.replace(/\s*\n\s*/g, ' ').trim()
    const next: HeadingBlock = {
      id: b.id,
      type: 'heading',
      level: clampLevel(level),
      text,
      versions: b.versions,
    }
    if (b.type === 'heading' && b.level === next.level && b.text === text) return false
    if (text !== b.text) pushVersion(next, text, 'convert')
    d.blocks[idx] = next
  } else {
    if (b.type === 'paragraph') return false
    const next: ParagraphBlock = { id: b.id, type: 'paragraph', text: b.text, versions: b.versions }
    d.blocks[idx] = next
  }
  dropSuggestionsFor(d, [id])
  return true
}

/** 回退到某个历史版本：作为一个新版本写入，历史不丢 */
export function rollback(d: ProjectData, id: string, versionIndex: number): boolean {
  const b = getBlock(d, id)
  const target = b?.versions[versionIndex]
  if (!b || !target || target.text === b.text) return false
  b.text = target.text
  pushVersion(b, target.text, 'rollback', `v${target.v}`)
  return true
}

/* ── 大纲与章节 ───────────────────────────────────── */

export function buildOutline(blocks: DocBlock[]): OutlineNode[] {
  const roots: OutlineNode[] = []
  const stack: OutlineNode[] = []
  for (const b of blocks) {
    if (b.type !== 'heading') continue
    const node: OutlineNode = { id: b.id, title: b.text, level: b.level, children: [] }
    while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

/** 章节结束位置（不含）：下一个同级或更高级标题 */
export function sectionEnd(blocks: DocBlock[], headingIndex: number): number {
  const h = blocks[headingIndex]
  if (!h || h.type !== 'heading') return headingIndex + 1
  for (let i = headingIndex + 1; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type === 'heading' && b.level <= h.level) return i
  }
  return blocks.length
}

/** 标题正下方、直到下一个任意级标题之前的段落 */
export function sectionBodyIds(blocks: DocBlock[], headingId: string): string[] {
  const idx = blocks.findIndex((b) => b.id === headingId)
  if (idx < 0) return []
  const ids: string[] = []
  for (let i = idx + 1; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type === 'heading') break
    ids.push(b.id)
  }
  return ids
}

/** 每个块所在的标题路径（根 → 最近标题），一次遍历算完 */
export function headingPaths(blocks: DocBlock[]): Map<string, HeadingBlock[]> {
  const map = new Map<string, HeadingBlock[]>()
  let stack: HeadingBlock[] = []
  for (const b of blocks) {
    if (b.type === 'heading') {
      stack = stack.filter((h) => h.level < b.level)
      map.set(b.id, stack)
      stack = [...stack, b]
    } else {
      map.set(b.id, stack)
    }
  }
  return map
}

export function outlineSummary(blocks: DocBlock[]): string {
  return blocks
    .filter((b): b is HeadingBlock => b.type === 'heading')
    .map((h) => `${'  '.repeat(h.level - 1)}- ${h.text}`)
    .join('\n')
}

/**
 * 移动整节（标题 + 其下全部内容）到目标标题的前 / 后 / 内部末尾，
 * 并按新位置调整整节的标题层级。
 */
export function moveSection(
  d: ProjectData,
  headingId: string,
  targetId: string,
  position: 'before' | 'after' | 'inside'
): boolean {
  const i = indexOfBlock(d, headingId)
  const t = indexOfBlock(d, targetId)
  const src = d.blocks[i]
  const tgt = d.blocks[t]
  if (!src || !tgt || src.type !== 'heading' || tgt.type !== 'heading') return false
  const end = sectionEnd(d.blocks, i)
  if (t >= i && t < end) return false // 不能移进自己
  const newLevel = position === 'inside' ? tgt.level + 1 : tgt.level
  const delta = newLevel - src.level
  const segment = d.blocks.slice(i, end)
  if (segment.some((b) => b.type === 'heading' && (b.level + delta < 1 || b.level + delta > 6))) {
    return false
  }
  d.blocks.splice(i, end - i)
  const t2 = indexOfBlock(d, targetId)
  const insertAt = position === 'before' ? t2 : sectionEnd(d.blocks, t2)
  for (const b of segment) if (b.type === 'heading') b.level += delta
  d.blocks.splice(insertAt, 0, ...segment)
  return true
}

/** 整节升级（delta = -1）或降级（delta = +1） */
export function shiftSectionLevel(d: ProjectData, headingId: string, delta: number): boolean {
  const i = indexOfBlock(d, headingId)
  if (d.blocks[i]?.type !== 'heading') return false
  const segment = d.blocks.slice(i, sectionEnd(d.blocks, i))
  if (segment.some((b) => b.type === 'heading' && (b.level + delta < 1 || b.level + delta > 6))) {
    return false
  }
  for (const b of segment) if (b.type === 'heading') b.level += delta
  return true
}

/* ── 建议 ─────────────────────────────────────────── */

/** 按空行把 AI 产出切成段落 */
export function splitIntoParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t　]*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim())
}

/** 目标位置当前的文本；目标已不存在或不再连续时返回 null */
export function targetText(d: ProjectData, target: SuggestionTarget): string | null {
  if (!target.blockIds.length) {
    if (target.insertAfter && indexOfBlock(d, target.insertAfter) < 0) return null
    return ''
  }
  const first = indexOfBlock(d, target.blockIds[0])
  if (first < 0) return null
  const blocks: ParagraphBlock[] = []
  for (let k = 0; k < target.blockIds.length; k++) {
    const b = d.blocks[first + k]
    if (!b || b.id !== target.blockIds[k] || b.type !== 'paragraph') return null
    blocks.push(b)
  }
  if (target.range) {
    if (blocks.length !== 1) return null
    const [s, e] = target.range
    if (e > blocks[0].text.length) return null
    return blocks[0].text.slice(s, e)
  }
  return blocks.map((b) => b.text).join('\n\n')
}

export function isStale(d: ProjectData, s: Suggestion): boolean {
  return targetText(d, s.target) !== s.original
}

function overlaps(a: SuggestionTarget, b: SuggestionTarget): boolean {
  if (!a.blockIds.length || !b.blockIds.length) {
    return !a.blockIds.length && !b.blockIds.length && a.insertAfter === b.insertAfter
  }
  return a.blockIds.some((id) => b.blockIds.includes(id))
}

export interface NewSuggestion {
  kind: Suggestion['kind']
  target: SuggestionTarget
  instruction: string | null
  original: string
  proposed: string
  issue?: string
  task?: Suggestion['task']
  author?: Suggestion['author']
  why?: string
  changeset?: string
}

/** 新增建议；同一位置上未处理的旧 AI 修改自动作废 */
export function addSuggestion(d: ProjectData, input: NewSuggestion): string {
  if (input.kind === 'ai_diff') {
    for (const old of d.suggestions) {
      if (old.state === 'pending' && old.kind === 'ai_diff' && overlaps(old.target, input.target)) {
        old.state = 'rejected'
      }
    }
  }
  const s: Suggestion = {
    id: uid('s'),
    kind: input.kind,
    target: input.target,
    instruction: input.instruction,
    original: input.original,
    proposed: input.proposed,
    candidates: input.kind === 'ai_diff' ? [input.proposed] : undefined,
    diff: input.kind === 'ai_diff' ? computeDiff(input.original, input.proposed) : [],
    state: 'pending',
    createdAt: nowISO(),
    ...(input.issue ? { issue: input.issue } : {}),
    ...(input.task ? { task: input.task } : {}),
    ...(input.author ? { author: input.author } : {}),
    ...(input.why ? { why: input.why } : {}),
    ...(input.changeset ? { changeset: input.changeset } : {}),
  }
  d.suggestions.push(s)
  return s.id
}

/** 切换 / 追加候选（"再来一版"） */
export function setSuggestionProposed(d: ProjectData, id: string, proposed: string): boolean {
  const s = d.suggestions.find((x) => x.id === id)
  if (!s || s.state !== 'pending') return false
  s.proposed = proposed
  if (!s.candidates) s.candidates = [proposed]
  else if (!s.candidates.includes(proposed)) s.candidates.push(proposed)
  s.diff = computeDiff(s.original, proposed)
  return true
}

/**
 * 按最终文本落地一条 AI 修改。原文在生成后被改动过（已过期）时拒绝执行，返回 null。
 * 返回落地后涉及的段落 id（便于界面重新定位）。
 */
export function applySuggestion(d: ProjectData, id: string, finalText: string): string[] | null {
  const s = d.suggestions.find((x) => x.id === id)
  if (!s || s.state !== 'pending' || s.kind !== 'ai_diff') return null
  if (isStale(d, s)) return null
  const source: VersionSource = s.author ? 'agent' : s.instruction ? 'ai_revise' : 'ai_rewrite'
  const instruction = s.author ? s.why ?? s.instruction : s.instruction
  const author = s.author?.name
  const { target } = s
  let ids: string[] = []

  if (target.range && target.blockIds.length === 1) {
    const b = getBlock(d, target.blockIds[0]) as ParagraphBlock
    const [start, end] = target.range
    editBlock(d, b.id, b.text.slice(0, start) + finalText + b.text.slice(end), source, instruction, author)
    ids = [b.id]
  } else if (target.blockIds.length) {
    const fresh = textToBlocks(finalText, source, instruction, author)
    const first = indexOfBlock(d, target.blockIds[0])
    const keep = d.blocks[first] as ParagraphBlock
    if (!fresh.length) {
      d.blocks.splice(first, target.blockIds.length)
    } else if (fresh[0].type === 'paragraph') {
      // 第一段沿用原段落（保留其版本历史），其余新建
      editBlock(d, keep.id, fresh[0].text, source, instruction, author)
      d.blocks.splice(first + 1, target.blockIds.length - 1, ...fresh.slice(1))
      ids = [keep.id, ...fresh.slice(1).map((b) => b.id)]
    } else {
      d.blocks.splice(first, target.blockIds.length, ...fresh)
      ids = fresh.map((b) => b.id)
    }
  } else {
    const fresh = textToBlocks(finalText, source, instruction, author)
    const at = target.insertAfter ? indexOfBlock(d, target.insertAfter) + 1 : 0
    d.blocks.splice(at, 0, ...fresh)
    ids = fresh.map((b) => b.id)
  }
  s.state = 'accepted'
  return ids
}

/** 单行 "## 标题" 形式的段落视为标题（AI / agent 写出的新内容里可以带小标题） */
const HEADING_LINE = /^(#{1,6})[ \t]+(\S[^\n]*)$/

/** 把一段文字切成新块：按空行分段，单行 "#" 开头的段落成为标题 */
export function textToBlocks(
  text: string,
  source: VersionSource,
  instruction: string | null,
  author?: string
): DocBlock[] {
  return splitIntoParagraphs(text).map((p) => {
    const m = HEADING_LINE.exec(p.trim())
    const block: DocBlock = m ? makeHeading(m[1].length, m[2].trim()) : makeParagraph(p)
    block.versions[0] = { ...block.versions[0], source, instruction, ...(author ? { author } : {}) }
    return block
  })
}

export function dismissSuggestion(d: ProjectData, id: string): boolean {
  const s = d.suggestions.find((x) => x.id === id)
  if (!s || s.state !== 'pending') return false
  s.state = 'rejected'
  return true
}

/** 块被删除 / 改结构后，指向它的待处理建议作废 */
function dropSuggestionsFor(d: ProjectData, ids: string[]): void {
  for (const s of d.suggestions) {
    if (s.state !== 'pending') continue
    const hit =
      s.target.blockIds.some((b) => ids.includes(b)) ||
      (s.target.insertAfter != null && ids.includes(s.target.insertAfter))
    if (hit) s.state = 'rejected'
  }
}

/** 某块上的待处理建议（AI 修改优先） */
export function pendingFor(d: ProjectData, blockId: string): Suggestion[] {
  return d.suggestions.filter(
    (s) =>
      s.state === 'pending' &&
      (s.target.blockIds.includes(blockId) ||
        (!s.target.blockIds.length && s.target.insertAfter === blockId))
  )
}

export interface PendingIndex {
  /** 以某段开头的待确认 AI 修改 id */
  diffByAnchor: Map<string, string>
  /** 挂在某段上的检查建议数 */
  notesByAnchor: Map<string, number>
  /** 要插在某块之后的待确认内容（续写、agent 新写的段落或图片） */
  insertAfter: Map<string, string>
}

const pendingCache = new WeakMap<Suggestion[], PendingIndex>()

/** 待处理建议按段落索引；同一份 suggestions 数组只算一次（immer 保证未变即同一引用） */
export function pendingIndex(suggestions: Suggestion[]): PendingIndex {
  const hit = pendingCache.get(suggestions)
  if (hit) return hit
  const index: PendingIndex = { diffByAnchor: new Map(), notesByAnchor: new Map(), insertAfter: new Map() }
  for (const s of suggestions) {
    if (s.state !== 'pending') continue
    const anchor = s.target.blockIds[0]
    if (!anchor) {
      if (s.kind === 'ai_diff' && s.target.insertAfter) index.insertAfter.set(s.target.insertAfter, s.id)
      continue
    }
    if (s.kind === 'ai_diff') index.diffByAnchor.set(anchor, s.id)
    else index.notesByAnchor.set(anchor, (index.notesByAnchor.get(anchor) ?? 0) + 1)
  }
  pendingCache.set(suggestions, index)
  return index
}

/** 整组接受某个变更集里待确认的修改（按提出顺序），过期的跳过 */
export function acceptChangeset(d: ProjectData, changeset: string): { applied: number; stale: number } {
  let applied = 0
  let stale = 0
  for (const s of d.suggestions) {
    if (s.changeset !== changeset || s.state !== 'pending' || s.kind !== 'ai_diff') continue
    if (applySuggestion(d, s.id, s.proposed)) applied++
    else {
      s.state = 'rejected'
      stale++
    }
  }
  return { applied, stale }
}

/** 整组放弃某个变更集里所有待处理的建议（含检查意见） */
export function rejectChangeset(d: ProjectData, changeset: string): number {
  let n = 0
  for (const s of d.suggestions) {
    if (s.changeset === changeset && s.state === 'pending') {
      s.state = 'rejected'
      n++
    }
  }
  return n
}

/**
 * 外部（agent / 其他程序）改了文件后，概括一下变化：新增了谁的多少条建议、正文变了几块。
 */
export function describeExternalChange(prev: ProjectData, next: ProjectData): {
  suggestionsBy: Record<string, number>
  changedBlocks: number
} {
  const known = new Set(prev.suggestions.map((s) => s.id))
  const suggestionsBy: Record<string, number> = {}
  for (const s of next.suggestions) {
    if (known.has(s.id) || s.state !== 'pending') continue
    const who = s.author?.name ?? '外部程序'
    suggestionsBy[who] = (suggestionsBy[who] ?? 0) + 1
  }
  const before = new Map(prev.blocks.map((b) => [b.id, b.text]))
  let changedBlocks = Math.abs(prev.blocks.length - next.blocks.length)
  for (const b of next.blocks) if (before.has(b.id) && before.get(b.id) !== b.text) changedBlocks++
  return { suggestionsBy, changedBlocks }
}

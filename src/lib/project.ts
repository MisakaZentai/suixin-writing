/**
 * 工程文件（suixin/project@2）的创建、序列化、读取与旧版迁移。
 *
 * 外部 agent 续作协议（v2）：
 * 1. `blocks` 是有序的标题 / 段落；`suggestions[state=pending]` 是待处理事项，
 *    `target.blockIds`（+ 可选 `range`）指明作用位置，`original` 是生成时的原文；
 * 2. 处理后把 `state` 置为 accepted / rejected，并相应改写 `blocks[].text`、追加 `versions`；
 * 3. 不认识的字段原样保留。
 */
import type {
  DocBlock,
  HeadingBlock,
  ParagraphBlock,
  ProjectData,
  Suggestion,
  Version,
} from '../types'
import { PROJECT_SCHEMA } from '../types'
import { computeDiff } from './diff'
import { nowISO, uid } from './ids'
import { clampLevel, parseDocument, toMarkdown } from './markdown'
import { sectionEnd } from './doc'

export const LEGACY_SCHEMA_PREFIX = 'ai-writer/project@'
export const PROJECT_FILE_SUFFIX = '.suixin.json'

export function createProject(title: string, blocks: DocBlock[] = [], titleAsHeading = true): ProjectData {
  const at = nowISO()
  return {
    schema: PROJECT_SCHEMA,
    meta: { title, createdAt: at, updatedAt: at, language: 'zh', titleAsHeading },
    blocks,
    suggestions: [],
  }
}

/** Markdown / 纯文本 → 新工程 */
export function projectFromText(
  text: string,
  fallbackTitle = '未命名文稿'
): { project: ProjectData; truncated: boolean } {
  const parsed = parseDocument(text)
  const project = createProject(parsed.title ?? fallbackTitle, parsed.blocks, parsed.title !== null)
  return { project, truncated: parsed.truncated }
}

export function exportMarkdown(data: ProjectData): string {
  return toMarkdown(data.meta, data.blocks)
}

/** 序列化：为方便外部 agent，额外写出派生的 status 字段（读取时忽略） */
export function serializeProject(data: ProjectData): string {
  const pending = new Set<string>()
  for (const s of data.suggestions) {
    if (s.state === 'pending' && s.kind === 'ai_diff') s.target.blockIds.forEach((id) => pending.add(id))
  }
  const doc = {
    ...data,
    schema: PROJECT_SCHEMA,
    meta: { ...data.meta, updatedAt: nowISO() },
    blocks: data.blocks.map((b) => ({ ...b, status: pending.has(b.id) ? 'pending' : 'clean' })),
  }
  return JSON.stringify(doc, null, 2)
}

export function parseProjectFile(text: string): ProjectData {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('文件不是有效的 JSON')
  }
  const schema = String(raw.schema ?? '')
  if (schema.startsWith(LEGACY_SCHEMA_PREFIX)) return migrateV1(raw)
  if (schema !== PROJECT_SCHEMA) {
    throw new Error(`无法识别的工程文件（schema="${schema || '缺失'}"），需要 ${PROJECT_SCHEMA}`)
  }
  const meta = (raw.meta ?? {}) as Record<string, unknown>
  const blocks = (Array.isArray(raw.blocks) ? raw.blocks : []).map((b, i) =>
    normalizeBlock(b as Record<string, unknown>, i)
  )
  const suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : []) as Suggestion[]
  // 未知字段原样保留（forward-compatible）
  return {
    ...(raw as object),
    schema: PROJECT_SCHEMA,
    meta: normalizeMeta(meta),
    blocks,
    suggestions: suggestions.filter((s) => s && s.target && Array.isArray(s.target.blockIds)),
  } as ProjectData
}

function normalizeMeta(meta: Record<string, unknown>): ProjectData['meta'] {
  return {
    ...(meta as object),
    title: String(meta.title ?? '未命名文稿'),
    createdAt: String(meta.createdAt ?? nowISO()),
    updatedAt: String(meta.updatedAt ?? nowISO()),
    language: String(meta.language ?? 'zh'),
    titleAsHeading: meta.titleAsHeading !== false,
  }
}

function normalizeVersions(raw: unknown, text: string): Version[] {
  const list = Array.isArray(raw) ? (raw as Version[]) : []
  return list.length ? list : [{ v: 0, text, source: 'import', instruction: null, at: nowISO() }]
}

function normalizeBlock(b: Record<string, unknown>, i: number): DocBlock {
  const text = String(b.text ?? '')
  const { status: _status, ...rest } = b
  const id = String(b.id ?? `b_restored_${i}`)
  if (b.type === 'heading') {
    return {
      ...(rest as object),
      id,
      type: 'heading',
      level: clampLevel(Number(b.level ?? 2)),
      text,
      versions: normalizeVersions(b.versions, text),
    } as HeadingBlock
  }
  return {
    ...(rest as object),
    id,
    type: 'paragraph',
    text,
    versions: normalizeVersions(b.versions, text),
  } as ParagraphBlock
}

/* ── v1 迁移 ─────────────────────────────────────────── */

interface V1Node {
  id: string
  title: string
  children: V1Node[]
}

interface V1Block {
  id: string
  outlineNodeId: string | null
  text: string
  paragraphId: string
}

/**
 * v1：正文按句子存储，段落由 paragraphId 聚合，大纲是独立的树。
 * 迁移：句子按段落拼回；块所在大纲路径变化处插入标题（顶层节点为二级标题）；
 * 从未挂过正文的大纲节点追加在文末。v1 的待处理建议只保留段落级的。
 */
function migrateV1(raw: Record<string, unknown>): ProjectData {
  const meta = normalizeMeta((raw.meta ?? {}) as Record<string, unknown>)
  const outline = (Array.isArray(raw.outline) ? raw.outline : []) as V1Node[]
  const v1Blocks = (Array.isArray(raw.blocks) ? raw.blocks : []) as V1Block[]

  const pathOf = new Map<string, V1Node[]>()
  const walk = (nodes: V1Node[], path: V1Node[]) => {
    for (const n of nodes) {
      pathOf.set(n.id, [...path, n])
      walk(n.children ?? [], [...path, n])
    }
  }
  walk(outline, [])

  const blocks: DocBlock[] = []
  const emitted = new Set<string>()
  const paragraphOf = new Map<string, string>() // v1 句子 id → v2 段落 id
  let currentPath: V1Node[] = []
  const at = meta.updatedAt

  const emitHeadings = (path: V1Node[]) => {
    let common = 0
    while (common < currentPath.length && common < path.length && currentPath[common].id === path[common].id) {
      common++
    }
    for (let d = common; d < path.length; d++) {
      const node = path[d]
      if (emitted.has(node.id)) continue
      emitted.add(node.id)
      blocks.push(v2Heading(node.id, d + 2, node.title, at))
    }
    currentPath = path
  }

  for (let i = 0; i < v1Blocks.length; ) {
    const pid = v1Blocks[i].paragraphId
    const group: V1Block[] = []
    while (i < v1Blocks.length && v1Blocks[i].paragraphId === pid) group.push(v1Blocks[i++])
    emitHeadings(pathOf.get(group[0].outlineNodeId ?? '') ?? [])
    const text = group.map((b) => String(b.text ?? '')).join('')
    const id = uid('b')
    group.forEach((b) => paragraphOf.set(b.id, id))
    blocks.push({
      id,
      type: 'paragraph',
      text,
      versions: [{ v: 0, text, source: 'import', instruction: null, at }],
    })
  }
  // 从未挂过正文的大纲节点：放回它在大纲里的位置（上一个兄弟节点那一节之后，
  // 或父节点正文之后），而不是统统堆到文末、落进别的章节
  const place = (nodes: V1Node[], parent: V1Node | null, depth: number) => {
    let prev: V1Node | null = null
    for (const n of nodes) {
      if (!emitted.has(n.id)) {
        let at_: number
        if (prev) {
          at_ = sectionEnd(blocks, blocks.findIndex((b) => b.id === prev!.id))
        } else if (parent) {
          at_ = blocks.findIndex((b) => b.id === parent.id) + 1
          while (at_ < blocks.length && blocks[at_].type !== 'heading') at_++
        } else {
          const first = blocks.findIndex((b) => b.type === 'heading')
          at_ = first < 0 ? blocks.length : first
        }
        blocks.splice(at_, 0, v2Heading(n.id, depth + 2, n.title, at))
        emitted.add(n.id)
      }
      place(n.children ?? [], n, depth + 1)
      prev = n
    }
  }
  place(outline, null, 0)

  const suggestions: Suggestion[] = []
  const v1Suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : []) as Record<string, unknown>[]
  for (const s of v1Suggestions) {
    if (s.state !== 'pending') continue
    const target = paragraphOf.get(String(s.blockId))
    const paragraph = blocks.find((b) => b.id === target)
    if (!paragraph) continue
    if (s.kind === 'ai_diff' && (s.scope ?? 'paragraph') === 'paragraph') {
      const proposed = String(s.proposed ?? '')
      suggestions.push({
        id: String(s.id ?? uid('s')),
        kind: 'ai_diff',
        target: { blockIds: [paragraph.id] },
        instruction: (s.instruction as string | null) ?? null,
        original: paragraph.text,
        proposed,
        candidates: [proposed],
        diff: computeDiff(paragraph.text, proposed),
        state: 'pending',
        createdAt: String(s.createdAt ?? at),
      })
    } else if (s.kind === 'alignment') {
      suggestions.push({
        id: String(s.id ?? uid('s')),
        kind: 'note',
        target: { blockIds: [paragraph.id] },
        instruction: (s.instruction as string | null) ?? null,
        original: paragraph.text,
        proposed: '',
        diff: [],
        state: 'pending',
        createdAt: String(s.createdAt ?? at),
      })
    }
  }

  return { schema: PROJECT_SCHEMA, meta, blocks, suggestions }
}

function v2Heading(id: string, level: number, text: string, at: string): HeadingBlock {
  return {
    id,
    type: 'heading',
    level: clampLevel(level),
    text,
    versions: [{ v: 0, text, source: 'import', instruction: null, at }],
  }
}

/* ── 文件名 ───────────────────────────────────────── */

export function safeFileName(title: string): string {
  return (title.trim() || '未命名文稿').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
}

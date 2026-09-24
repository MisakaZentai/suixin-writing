/**
 * 工程 IO 与派生视图（spec §5 / §6 F5 / F6）。
 * - getDisplayBlocks：三档粒度下的“显示块”计算（底层永远按句子存）
 * - buildProjectJson / parseProjectJson：自描述工程 JSON
 * - exportMarkdown：大纲转标题层级 + 块按序拼接
 */
import type {
  Block,
  DisplayBlock,
  Granularity,
  OutlineNode,
  OutlineNodeWithPath,
  ProjectData,
  Suggestion,
} from '../types'
import { splitSentences } from './segmenter'

/* ── 大纲工具 ────────────────────────────────────────── */

export function flattenOutline(nodes: OutlineNode[]): OutlineNodeWithPath[] {
  const out: OutlineNodeWithPath[] = []
  const walk = (list: OutlineNode[], path: OutlineNode[]) => {
    for (const n of list) {
      out.push({ node: n, path: [...path, n] })
      walk(n.children, [...path, n])
    }
  }
  walk(nodes, [])
  return out
}

/** 节点 id → 节点路径（根→自身），找不到返回 null */
export function findOutlinePath(
  nodes: OutlineNode[],
  id: string | null
): OutlineNode[] | null {
  if (!id) return null
  const walk = (list: OutlineNode[], path: OutlineNode[]): OutlineNode[] | null => {
    for (const n of list) {
      const next = [...path, n]
      if (n.id === id) return next
      const found = walk(n.children, next)
      if (found) return found
    }
    return null
  }
  return walk(nodes, [])
}

/* ── 显示块（粒度视图） ──────────────────────────────── */

const JOIN_IN_PARAGRAPH = ''
const JOIN_BETWEEN = '\n\n'

export function getDisplayBlocks(
  data: ProjectData,
  granularity: Granularity
): DisplayBlock[] {
  const blockMap = new Map(data.blocks.map((b) => [b.id, b]))
  const pendingBlockIds = new Set(
    data.suggestions
      .filter((s) => s.state === 'pending' && s.kind === 'ai_diff')
      .map((s) => s.blockId)
  )

  const groups: string[][] = []
  if (granularity === 'full') {
    if (data.blocks.length) groups.push(data.blocks.map((b) => b.id))
  } else if (granularity === 'paragraph') {
    let currentParagraph: string | null = null
    for (const b of data.blocks) {
      if (b.paragraphId !== currentParagraph || !groups.length) {
        groups.push([])
        currentParagraph = b.paragraphId
      }
      groups[groups.length - 1].push(b.id)
    }
  } else {
    for (const b of data.blocks) groups.push([b.id])
  }

  return groups.map((ids) => {
    const segs = ids.map((id) => blockMap.get(id)!).filter(Boolean)
    const first = segs[0]
    const text =
      granularity === 'sentence'
        ? first.text
        : granularity === 'paragraph'
          ? segs.map((s) => s.text).join(JOIN_IN_PARAGRAPH)
          : joinParagraphs(data.blocks)
    const status: Block['status'] =
      segs.some((s) => pendingBlockIds.has(s.id))
        ? 'pending'
        : segs.some((s) => s.status === 'dirty')
          ? 'dirty'
          : 'clean'
    const outlineNodeId = first.outlineNodeId ?? null
    return {
      key:
        granularity === 'full'
          ? 'full'
          : granularity === 'paragraph'
            ? `p:${first.paragraphId}`
            : `s:${first.id}`,
      blockIds: ids,
      text,
      versions: first.versions,
      status,
      outlineNodeId,
      outlinePath: findOutlinePath(data.outline, outlineNodeId) ?? [],
    }
  })
}

/** 全文粒度：段落间空行拼接 */
export function joinParagraphs(blocks: Block[]): string {
  const out: string[] = []
  let currentPid: string | null = null
  for (const b of blocks) {
    if (b.paragraphId !== currentPid) {
      out.push('')
      currentPid = b.paragraphId
    }
    out.push(b.text)
  }
  return out.join('').replace(/^\n\n/, '')
}

/** 找出某个显示块下所有底层块 */
export function getGroupBlocks(data: ProjectData, key: string): Block[] {
  return data.blocks.filter((b) => {
    if (key === 'full') return true
    if (key.startsWith('p:')) return b.paragraphId === key.slice(2)
    if (key.startsWith('s:')) return b.id === key.slice(2)
    return false
  })
}

/* ── 工程 JSON ───────────────────────────────────────── */

export function buildProjectJson(data: ProjectData): string {
  const pendingBlockIds = new Set(
    data.suggestions
      .filter((s) => s.state === 'pending' && s.kind === 'ai_diff')
      .map((s) => s.blockId)
  )
  const blocks = data.blocks.map((b, i) => ({
    ...b,
    order: i,
    status: pendingBlockIds.has(b.id)
      ? ('pending' as const)
      : b.status === 'active'
        ? ('clean' as const)
        : b.status,
  }))
  // 未知字段原样保留（forward-compatible，spec §5）；schema 置顶方便外部 agent 识别
  const {
    schema: _s,
    meta: _m,
    settings: _st,
    outline: _o,
    blocks: _b,
    suggestions: _su,
    ...extras
  } = data
  const doc = {
    schema: 'ai-writer/project@1',
    meta: { ...data.meta, updatedAt: new Date().toISOString() },
    settings: { ...data.settings },
    outline: data.outline,
    blocks,
    suggestions: data.suggestions,
    ...extras,
  }
  return JSON.stringify(doc, null, 2)
}

export function parseProjectJson(text: string): ProjectData {
  const raw = JSON.parse(text) as Record<string, unknown>
  const schema = String(raw.schema ?? '')
  if (!schema.startsWith('ai-writer/project@')) {
    throw new Error(
      `无法识别的工程文件（schema="${schema || '缺失'}"）。需要 ai-writer/project@1。`
    )
  }
  const meta = (raw.meta ?? {}) as Partial<ProjectData['meta']>
  const settings = (raw.settings ?? {}) as Partial<ProjectData['settings']>
  const outline = Array.isArray(raw.outline) ? (raw.outline as OutlineNode[]) : []
  const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : []
  const blocks: Block[] = rawBlocks.map((b, i) => {
    const block = b as Record<string, unknown>
    return {
      id: String(block.id ?? `b_${i}`),
      outlineNodeId: (block.outlineNodeId as string | null) ?? null,
      order: typeof block.order === 'number' ? block.order : i,
      text: String(block.text ?? ''),
      status: (block.status as Block['status']) ?? 'clean',
      versions: Array.isArray(block.versions) ? block.versions : [],
      paragraphId: block.paragraphId
        ? String(block.paragraphId)
        : `p_restored_${i}`,
    }
  })
  const suggestions: Suggestion[] = (Array.isArray(raw.suggestions)
    ? raw.suggestions
    : []
  ).map((s) => s as Suggestion)
  // 未知字段原样保留（forward-compatible，spec §5）
  return {
    ...(raw as unknown as ProjectData),
    schema: 'ai-writer/project@1',
    meta: {
      title: String(meta.title ?? '未命名文稿'),
      createdAt: String(meta.createdAt ?? new Date().toISOString()),
      updatedAt: String(meta.updatedAt ?? new Date().toISOString()),
      language: String(meta.language ?? 'zh'),
    },
    settings: {
      model: String(settings.model ?? 'deepseek-chat'),
      baseURL: String(settings.baseURL ?? 'https://api.deepseek.com/v1'),
      temperature: typeof settings.temperature === 'number' ? settings.temperature : 0.7,
    },
    outline,
    blocks,
    suggestions,
  }
}

/* ── Markdown 导出 ───────────────────────────────────── */

export function exportMarkdown(data: ProjectData): string {
  const lines: string[] = [`# ${data.meta.title}`, '']
  let currentPath: OutlineNode[] | null = null
  for (let i = 0; i < data.blocks.length; i++) {
    const b = data.blocks[i]
    const path = findOutlinePath(data.outline, b.outlineNodeId) ?? []
    if (!samePath(currentPath, path)) {
      // 只对“新进入”的层级输出标题，避免整条路径重复刷屏
      const common = commonPrefixLength(currentPath ?? [], path)
      for (let d = common; d < path.length; d++) {
        lines.push(`${'#'.repeat(d + 2)} ${path[d].title}`, '')
      }
      currentPath = path
    }
    lines.push(b.text)
    const next = data.blocks[i + 1]
    if (!next || next.paragraphId !== b.paragraphId) lines.push('')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimStart() + '\n'
}

function samePath(a: OutlineNode[] | null, b: OutlineNode[]): boolean {
  if (!a || a.length !== b.length) return false
  return a.every((n, i) => n.id === b[i].id)
}

function commonPrefixLength(a: OutlineNode[], b: OutlineNode[]): number {
  let i = 0
  while (i < a.length && i < b.length && a[i].id === b[i].id) i++
  return i
}

/* ── 句子重组（编辑/AI 结果落盘用） ───────────────────── */

/** 把一段文本重新切成句子块，继承原组的 paragraphId 与挂靠节点 */
export function resegmentText(
  text: string,
  template: { paragraphId: string; outlineNodeId: string | null },
  startOrder: number
): { id: string; outlineNodeId: string | null; order: number; text: string; status: 'clean'; paragraphId: string }[] {
  const sentences = splitSentences(text)
  return sentences.map((s, i) => ({
    id: `b_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 8)}`,
    outlineNodeId: template.outlineNodeId,
    order: startOrder + i,
    text: s,
    status: 'clean' as const,
    paragraphId: template.paragraphId,
  }))
}

/**
 * 把 agent 给的定位解析成文档里的具体位置。
 * agent 习惯用文字而不是 id 指代位置，所以引文（quote）是一等公民：
 * 找不到或找到多处时都给出明确的错误与候选，让它自己修正。
 */
import type { DocBlock, HeadingBlock, ProjectData } from '../types'
import { headingPaths, indexOfBlock, sectionBodyIds, sectionEnd } from '../lib/doc'
import { AgentError } from './errors'

export interface TargetSpec {
  block?: string
  blocks?: string[]
  quote?: string
  occurrence?: number
  in?: string
  section?: string
}

export interface ResolvedTarget {
  kind: 'paragraph' | 'paragraphs' | 'range' | 'section'
  /** 目标段落（section 且没有正文时为空） */
  blockIds: string[]
  range?: [number, number]
  headingId?: string
}

const CONTEXT = 16

function snippet(text: string, start: number, end: number): string {
  const a = Math.max(0, start - CONTEXT)
  const b = Math.min(text.length, end + CONTEXT)
  return `${a > 0 ? '…' : ''}${text.slice(a, b)}${b < text.length ? '…' : ''}`
}

/** 按 id 或逐字标题找标题块 */
export function resolveHeading(d: ProjectData, ref: string): HeadingBlock {
  const byId = d.blocks.find((b) => b.id === ref)
  if (byId) {
    if (byId.type !== 'heading') {
      throw new AgentError('INVALID_PARAMS', `${ref} 是段落，不是标题`)
    }
    return byId
  }
  const hits = d.blocks.filter((b): b is HeadingBlock => b.type === 'heading' && b.text.trim() === ref.trim())
  if (!hits.length) {
    throw new AgentError('NOT_FOUND', `找不到标题「${ref}」`, '运行 outline 查看全部标题与 id')
  }
  if (hits.length > 1) {
    throw new AgentError(
      'AMBIGUOUS',
      `有 ${hits.length} 个标题都叫「${ref}」`,
      '改用标题 id',
      hits.map((h) => ({ id: h.id, level: h.level, text: h.text }))
    )
  }
  return hits[0]
}

/** 引文搜索范围：整篇 / 某一段 / 某一节（含子节） */
function searchScope(d: ProjectData, scope?: string): DocBlock[] {
  if (!scope) return d.blocks
  const block = d.blocks.find((b) => b.id === scope)
  if (block?.type === 'paragraph') return [block]
  const heading = resolveHeading(d, scope)
  const i = indexOfBlock(d, heading.id)
  return d.blocks.slice(i, sectionEnd(d.blocks, i))
}

export interface QuoteMatch {
  block: string
  start: number
  end: number
  context: string
}

export function findQuote(d: ProjectData, quote: string, scope?: string): QuoteMatch[] {
  const out: QuoteMatch[] = []
  if (!quote) return out
  for (const b of searchScope(d, scope)) {
    if (b.type !== 'paragraph') continue
    let from = 0
    for (;;) {
      const at = b.text.indexOf(quote, from)
      if (at < 0) break
      out.push({ block: b.id, start: at, end: at + quote.length, context: snippet(b.text, at, at + quote.length) })
      from = at + Math.max(1, quote.length)
    }
  }
  return out
}

export function resolveTarget(d: ProjectData, spec: TargetSpec): ResolvedTarget {
  const given = ['block', 'blocks', 'quote', 'section'].filter(
    (k) => spec[k as keyof TargetSpec] !== undefined
  )
  if (given.length !== 1) {
    throw new AgentError(
      'INVALID_PARAMS',
      given.length ? `定位只能给一种，现在给了 ${given.join('、')}` : '缺少定位',
      '用 {"block": id}、{"blocks": [id…]}、{"quote": "原文"} 或 {"section": "标题"} 之一'
    )
  }

  if (spec.block !== undefined) {
    const b = d.blocks.find((x) => x.id === spec.block)
    if (!b) throw new AgentError('NOT_FOUND', `找不到段落 ${spec.block}`, '运行 read 查看段落 id')
    if (b.type === 'heading') {
      throw new AgentError('INVALID_PARAMS', `${spec.block} 是标题`, '改标题用 rename_heading；改这一节的正文用 {"section": …}')
    }
    return { kind: 'paragraph', blockIds: [b.id] }
  }

  if (spec.blocks !== undefined) {
    if (!spec.blocks.length) throw new AgentError('INVALID_PARAMS', 'blocks 不能为空')
    const first = indexOfBlock(d, spec.blocks[0])
    if (first < 0) throw new AgentError('NOT_FOUND', `找不到段落 ${spec.blocks[0]}`)
    spec.blocks.forEach((id, k) => {
      const b = d.blocks[first + k]
      if (!b || b.id !== id) {
        throw new AgentError('INVALID_PARAMS', 'blocks 必须是文档中连续的段落，并按顺序给出', '运行 read 核对顺序')
      }
      if (b.type !== 'paragraph') {
        throw new AgentError('INVALID_PARAMS', `${id} 是标题，blocks 里只能是段落`, '跨章节的修改请分节进行')
      }
    })
    return { kind: spec.blocks.length === 1 ? 'paragraph' : 'paragraphs', blockIds: [...spec.blocks] }
  }

  if (spec.section !== undefined) {
    const h = resolveHeading(d, spec.section)
    return { kind: 'section', blockIds: sectionBodyIds(d.blocks, h.id), headingId: h.id }
  }

  const quote = spec.quote ?? ''
  if (!quote.trim()) throw new AgentError('INVALID_PARAMS', 'quote 不能为空')
  if (quote.includes('\n\n')) {
    throw new AgentError('UNSUPPORTED', '引文不能跨段', '跨段的修改用 {"blocks": [...]} 定位')
  }
  const hits = findQuote(d, quote, spec.in)
  if (!hits.length) {
    throw new AgentError('NOT_FOUND', `原文里找不到引文「${quote}」`, '引文必须与原文逐字一致（含标点）；可先用 find 查找')
  }
  let hit = hits[0]
  if (spec.occurrence !== undefined) {
    hit = hits[spec.occurrence - 1]
    if (!hit) throw new AgentError('NOT_FOUND', `引文只出现了 ${hits.length} 次，没有第 ${spec.occurrence} 处`)
  } else if (hits.length > 1) {
    throw new AgentError(
      'AMBIGUOUS',
      `引文「${quote}」出现了 ${hits.length} 次`,
      '加上 occurrence（第几处，从 1 开始），或用 in 限定段落 / 章节',
      hits.map((h, i) => ({ occurrence: i + 1, block: h.block, context: h.context }))
    )
  }
  const b = d.blocks.find((x) => x.id === hit.block)!
  // 引到整段时按整段处理，结果更干净
  if (hit.start === 0 && hit.end === b.text.length) return { kind: 'paragraph', blockIds: [b.id] }
  return { kind: 'range', blockIds: [b.id], range: [hit.start, hit.end] }
}

/** 插入位置：返回"插在哪一块之后"（null = 文首） */
export function resolvePosition(d: ProjectData, pos: 'start' | 'end' | TargetSpec): string | null {
  if (pos === 'start') return null
  if (pos === 'end') return d.blocks[d.blocks.length - 1]?.id ?? null
  if (pos.section !== undefined) {
    const h = resolveHeading(d, pos.section)
    const i = indexOfBlock(d, h.id)
    // 插在这一节（含子节）末尾
    return d.blocks[sectionEnd(d.blocks, i) - 1].id
  }
  const t = resolveTarget(d, pos)
  return t.blockIds[t.blockIds.length - 1]
}

/** 块所在章节路径文字，如"第一章 / 第一节" */
export function pathOf(d: ProjectData, id: string): string {
  return (headingPaths(d.blocks).get(id) ?? []).map((h) => h.text).join(' / ')
}

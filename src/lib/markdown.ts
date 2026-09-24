/**
 * Markdown / 纯文本 ↔ 文档块。
 *
 * 目标：规范化的 Markdown（块之间一个空行、ATX 标题）导入后原样导出逐字节一致。
 * - `#` 标题成为标题块，层级原样保留；文首唯一的一级标题作为文稿标题；
 * - 空行分段，段内换行原样保留；
 * - 代码围栏内不识别标题、不按空行切分；
 * - 完全没有空行的多行文本（常见于从 Word / 网页复制的中文）按"一行一段"处理。
 */
import type { DocBlock, HeadingBlock, ParagraphBlock } from '../types'
import { nowISO, uid } from './ids'

export const MAX_DOC_CHARS = 200_000

export interface ParsedDocument {
  /** 文首唯一一级标题；没有则为 null */
  title: string | null
  blocks: DocBlock[]
  truncated: boolean
}

const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

export function makeParagraph(text: string, source: 'import' | 'manual' | 'split' = 'import'): ParagraphBlock {
  return {
    id: uid('b'),
    type: 'paragraph',
    text,
    versions: [{ v: 0, text, source, instruction: null, at: nowISO() }],
  }
}

export function makeHeading(level: number, text: string, source: 'import' | 'manual' = 'import'): HeadingBlock {
  return {
    id: uid('h'),
    type: 'heading',
    level: clampLevel(level),
    text,
    versions: [{ v: 0, text, source, instruction: null, at: nowISO() }],
  }
}

export function clampLevel(level: number): number {
  return Math.min(6, Math.max(1, Math.round(level)))
}

export function parseDocument(raw: string): ParsedDocument {
  let text = raw.replace(/\r\n?/g, '\n')
  let truncated = false
  if (text.length > MAX_DOC_CHARS) {
    text = text.slice(0, MAX_DOC_CHARS)
    truncated = true
  }
  const lines = text.split('\n')
  const lineMode = isLinePerParagraph(lines)

  const blocks: DocBlock[] = []
  let pending: string[] = []
  let fence: string | null = null

  const flush = () => {
    // 去掉首尾空白行，段内内容（含缩进、行尾空格）原样保留
    while (pending.length && !pending[0].trim()) pending.shift()
    while (pending.length && !pending[pending.length - 1].trim()) pending.pop()
    if (pending.length) blocks.push(makeParagraph(pending.join('\n')))
    pending = []
  }

  for (const line of lines) {
    if (fence) {
      pending.push(line)
      if (line.trim().startsWith(fence)) fence = null
      continue
    }
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      // 围栏紧跟在文字后面时与之同属一块，导出时才能原样还原
      pending.push(line)
      fence = fenceMatch[1]
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading && heading[2].trim()) {
      flush()
      blocks.push(makeHeading(heading[1].length, heading[2].trim()))
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    pending.push(line)
    if (lineMode) flush()
  }
  flush()

  // 文首唯一的一级标题 → 文稿标题
  let title: string | null = null
  const h1s = blocks.filter((b) => b.type === 'heading' && b.level === 1)
  const first = blocks[0]
  if (first && first.type === 'heading' && first.level === 1) {
    title = first.text
    if (h1s.length === 1) blocks.shift()
  }

  return { title, blocks, truncated }
}

/** 没有任何空行、却有多行正文 → 视为"一行一段" */
function isLinePerParagraph(lines: string[]): boolean {
  const nonEmpty = lines.filter((l) => l.trim())
  if (nonEmpty.length < 2) return false
  if (lines.some((l, i) => !l.trim() && i > 0 && i < lines.length - 1)) return false
  // Markdown 列表 / 引用 / 围栏在一起时通常是有意的软换行，不拆
  return !nonEmpty.some((l) => /^\s*([-*+]\s|\d+[.)]\s|>|`{3}|~{3})/.test(l))
}

export interface MarkdownMeta {
  title: string
  /** 导出时是否把文稿标题写成文首的一级标题 */
  titleAsHeading?: boolean
}

export function toMarkdown(meta: MarkdownMeta, blocks: DocBlock[]): string {
  const parts: string[] = []
  const first = blocks[0]
  const titleAlreadyFirst =
    first?.type === 'heading' && first.level === 1 && first.text === meta.title
  if (meta.titleAsHeading !== false && meta.title.trim() && !titleAlreadyFirst) {
    parts.push(`# ${meta.title.trim()}`)
  }
  for (const b of blocks) {
    if (b.type === 'heading') {
      if (b.text.trim()) parts.push(`${'#'.repeat(b.level)} ${b.text.trim()}`)
    } else if (b.text.trim()) {
      parts.push(b.text)
    }
  }
  return parts.length ? parts.join('\n\n') + '\n' : ''
}

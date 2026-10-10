/**
 * 段落文字的显示：Markdown 模式下按语法渲染，并叠加 AI 味命中、AI 选区等高亮。
 *
 * 两种看法共用一棵语法树，DOM 里的文字始终与源文字逐字对应（标记符号只是被隐藏或变淡）：
 * - rendered：阅读时。标记隐藏，加粗、列表、引用等显示成效果；
 * - source：编辑时垫在输入框下面。标记变淡，效果只用不改变字宽的样式（描边加粗、合成斜体、
 *   底色、颜色），保证与输入框里的文字逐字对齐。
 */
import { useMemo, type ReactNode } from 'react'
import { parseInline, parseMarkdown, type Inline, type MdLine } from '../lib/md'

export interface Highlight {
  from: number
  to: number
  className: string
  title?: string
}

interface Props {
  text: string
  mode: 'rendered' | 'source'
  highlights?: Highlight[]
  /** 不解析语法，只显示源文字（关闭 Markdown 模式时） */
  plain?: boolean
}

export function MdText({ text, mode, highlights = [], plain = false }: Props) {
  const block = useMemo(() => (plain ? null : parseMarkdown(text)), [text, plain])
  let key = 0

  /** [from, to) 的文字，按高亮切开 */
  const seg = (from: number, to: number): ReactNode[] => {
    if (to <= from) return []
    const inside = highlights.filter((h) => h.from < to && from < h.to)
    if (!inside.length) return [text.slice(from, to)]
    const cuts = [...new Set([from, to, ...inside.flatMap((h) => [h.from, h.to])])].filter((x) => x >= from && x <= to).sort((a, b) => a - b)
    const out: ReactNode[] = []
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [a, b] = [cuts[i], cuts[i + 1]]
      const cover = inside.filter((h) => h.from < b && a < h.to)
      const piece = text.slice(a, b)
      if (!cover.length) out.push(piece)
      else {
        const top = cover[cover.length - 1]
        out.push(
          <mark key={key++} className={top.className} title={cover.map((h) => h.title).filter(Boolean).join('\n') || undefined}>
            {piece}
          </mark>
        )
      }
    }
    return out
  }

  const inline = (xs: Inline[]): ReactNode[] =>
    xs.map((x) => {
      if (x.k === 'text') return <span key={key++}>{seg(x.from, x.to)}</span>
      if (x.k === 'mark') return <span key={key++} className="md-mark">{seg(x.from, x.to)}</span>
      const children = inline(x.children)
      if (x.k === 'link') {
        // 不做成真链接：在编辑器里点一下是选中段落，不该跳走
        return (
          <span key={key++} className="md-link" title={x.href}>
            {children}
          </span>
        )
      }
      const Tag = x.k === 'strong' ? 'strong' : x.k === 'em' ? 'em' : x.k === 'del' ? 'del' : 'code'
      return (
        <Tag key={key++} className={`md-${x.k}`}>
          {children}
        </Tag>
      )
    })

  // 没有任何语法：保持一个纯文本节点（与关闭 Markdown 模式时一样）
  if (!block || block.plain) return <>{seg(0, text.length)}</>

  /** 不参与显示、只为保持文字逐字对应的隐藏片段（| 、换行、分隔行等） */
  const hidden = (from: number, to: number): ReactNode =>
    to > from ? (
      <span key={key++} className="md-mark">
        {seg(from, to)}
      </span>
    ) : null

  /** 表格的一行：单元格按列对齐，| 与换行藏进格子边缘 */
  const tableRow = (l: MdLine, headExtra: ReactNode[] = [], tailExtra: ReactNode[] = []): ReactNode => {
    const cells = l.cells ?? []
    const aligns = l.aligns ?? []
    return (
      <span key={key++} className="md-tr">
        {cells.map((c, ci) => {
          const align = aligns[ci]
          return (
            <span key={c.from} className="md-td" style={align && align !== 'left' ? { textAlign: align } : undefined}>
              {ci === 0 && headExtra}
              {ci === 0 && hidden(l.from, c.from)}
              {inline(parseInline(text, c.from, c.to))}
              {ci + 1 < cells.length ? hidden(c.to, cells[ci + 1].from) : hidden(c.to, l.to)}
              {ci === cells.length - 1 && tailExtra}
            </span>
          )
        })}
      </span>
    )
  }

  /** 一整个表格：lines[i] 是表头、lines[i+1] 是分隔行、之后是表体 */
  const tableRun = (i: number): ReactNode => {
    const header = block.lines[i]
    const delim = block.lines[i + 1]
    const body: MdLine[] = []
    let j = i + 2
    while (j < block.lines.length && block.lines[j].kind === 'table') body.push(block.lines[j++])
    // 表头换行 + 整个分隔行 + 分隔行换行：藏进表体首格（没有表体就藏进表头末格）
    const mid = [
      hidden(header.to, delim.from),
      hidden(delim.from, delim.to),
      body.length ? hidden(delim.to, body[0].from) : j < block.lines.length ? hidden(delim.to, block.lines[j].from) : null,
    ]
    return (
      <span key={key++} className="md-table">
        <span className="md-thead">{tableRow(header, [], body.length ? [] : mid)}</span>
        <span className="md-tbody">
          {body.map((l, bi) =>
            tableRow(
              l,
              bi === 0 ? mid : [],
              bi + 1 < body.length ? [hidden(l.to, body[bi + 1].from)] : j < block.lines.length ? [hidden(l.to, l.to + 1)] : [],
            ),
          )}
        </span>
      </span>
    )
  }

  const line = (l: MdLine, i: number, last: boolean): ReactNode => {
    const prefix =
      l.prefixEnd > l.from ? (
        <span className={l.kind === 'ol' ? 'md-mark md-ol-num' : 'md-mark'}>{seg(l.from, l.prefixEnd)}</span>
      ) : null
    const nl = last ? null : <span className="md-mark md-nl">{seg(l.to, l.to + 1)}</span>
    const body = l.kind === 'code' || l.kind === 'fence' ? seg(l.prefixEnd, l.to) : inline(l.children)
    if (mode === 'source') {
      return (
        <span key={i} className={`md-src-${l.kind}`}>
          {prefix}
          {body}
          {nl}
        </span>
      )
    }
    return (
      <span
        key={i}
        className={`md-line md-${l.kind}${l.level && l.kind === 'h' ? ` md-h${l.level}` : ''}`}
        style={l.indent ? { marginLeft: `${l.indent * 1.5}em` } : undefined}
      >
        {prefix}
        {body}
        {nl}
      </span>
    )
  }

  if (mode === 'source') return <>{block.lines.map((l, i) => line(l, i, i === block.lines.length - 1))}</>

  // 阅读时：表格（表头 + 分隔行 + 表体）合并渲染成网格，其余行照常
  const out: ReactNode[] = []
  for (let i = 0; i < block.lines.length; i++) {
    const l = block.lines[i]
    if (l.kind === 'table' && block.lines[i + 1]?.kind === 'tdelim') {
      out.push(tableRun(i))
      while (i < block.lines.length && (block.lines[i].kind === 'table' || block.lines[i].kind === 'tdelim')) i++
      i--
      continue
    }
    if (l.kind === 'table' || l.kind === 'tdelim') {
      out.push(line({ ...l, kind: 'p' }, i, i === block.lines.length - 1))
      continue
    }
    out.push(line(l, i, i === block.lines.length - 1))
  }
  return <>{out}</>
}

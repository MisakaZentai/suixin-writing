/**
 * 段落文字的显示：Markdown 模式下按语法渲染，并叠加 AI 味命中、AI 选区等高亮。
 *
 * 两种看法共用一棵语法树，DOM 里的文字始终与源文字逐字对应（标记符号只是被隐藏或变淡）：
 * - rendered：阅读时。标记隐藏，加粗、列表、引用等显示成效果；
 * - source：编辑时垫在输入框下面。标记变淡，效果只用不改变字宽的样式（描边加粗、合成斜体、
 *   底色、颜色），保证与输入框里的文字逐字对齐。
 */
import { useMemo, type ReactNode } from 'react'
import { parseMarkdown, type Inline, type MdLine } from '../lib/md'

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

  return <>{block.lines.map((l, i) => line(l, i, i === block.lines.length - 1))}</>
}

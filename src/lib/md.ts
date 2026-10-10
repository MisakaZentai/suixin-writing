/**
 * 段落内的 Markdown 解析：给「Markdown 模式」渲染用。
 *
 * 与导出用的 marked 不同，这里的结果保留源文字的每一个字符及其位置：标记符号（** 、- 、> 等）
 * 也作为节点留着，阅读时隐藏、编辑时变淡。这样渲染出来的 DOM 文字与源文字逐字对应，
 * 划选、双击落点、AI 改选中文字等按文字偏移工作的功能都不受影响。
 *
 * 支持：**粗** __粗__ *斜* _斜_ ~~删除线~~ `代码` [链接](url) ![图](src) 反斜杠转义；
 * 行首的 - * + 列表、1. 有序列表、> 引用、# 标题、--- 分割线；``` 代码块（整段）；
 * GFM 表格（表头行 + |---| 分隔行 + 数据行，竖线与分隔行也是标记）。
 */

export type InlineKind = 'strong' | 'em' | 'del' | 'code' | 'link'

export type CellAlign = 'left' | 'center' | 'right'

export type Inline =
  | { k: 'text'; from: number; to: number }
  | { k: 'mark'; from: number; to: number }
  | { k: InlineKind; from: number; to: number; children: Inline[]; href?: string }
  /** 表格的一格：[from, to) 是去掉首尾空白后的内容，可以为空 */
  | { k: 'cell'; from: number; to: number; children: Inline[]; align?: CellAlign }

/** tr = 表格的表头行或数据行，tdelim = 表头下面的 |---| 分隔行 */
export type LineKind = 'p' | 'ul' | 'ol' | 'quote' | 'h' | 'hr' | 'code' | 'fence' | 'tr' | 'tdelim'

export interface MdLine {
  kind: LineKind
  from: number
  /** 不含换行符 */
  to: number
  /** 行首标记 [from, prefixEnd)：列表符号、> 、# 等 */
  prefixEnd: number
  /** 有序列表的序号、标题的级别 */
  level?: number
  /** 列表缩进层级（每两个空格一级） */
  indent?: number
  /** 表格行：属于这一段里的第几张表（从 0 开始），表头行带 header */
  table?: number
  header?: boolean
  children: Inline[]
}

export interface MdBlock {
  lines: MdLine[]
  /** 没有任何 Markdown 语法：直接当纯文字显示 */
  plain: boolean
}

/* ── 行内 ─────────────────────────────────────────── */

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/
const WORD = /[A-Za-z0-9]/

interface Delim {
  open: string
  kind: InlineKind
}

const DELIMS: Delim[] = [
  { open: '**', kind: 'strong' },
  { open: '__', kind: 'strong' },
  { open: '~~', kind: 'del' },
  { open: '*', kind: 'em' },
  { open: '_', kind: 'em' },
]

/** 在 [from, to) 里解析行内语法 */
export function parseInline(text: string, from: number, to: number): Inline[] {
  const out: Inline[] = []
  let textStart = from
  const flush = (end: number) => {
    if (end > textStart) out.push({ k: 'text', from: textStart, to: end })
  }
  let i = from
  while (i < to) {
    const c = text[i]
    // 转义：\* → 字面的 *
    if (c === '\\' && i + 1 < to && PUNCT.test(text[i + 1])) {
      flush(i)
      out.push({ k: 'mark', from: i, to: i + 1 })
      textStart = i + 1
      i += 2
      continue
    }
    // 行内代码：同样长度的反引号收尾，里面不再解析
    if (c === '`') {
      let n = 1
      while (text[i + n] === '`') n++
      const fence = '`'.repeat(n)
      const close = text.indexOf(fence, i + n)
      if (close > i + n && close + n <= to && text[close + n] !== '`') {
        flush(i)
        out.push({
          k: 'code',
          from: i,
          to: close + n,
          children: [
            { k: 'mark', from: i, to: i + n },
            { k: 'text', from: i + n, to: close },
            { k: 'mark', from: close, to: close + n },
          ],
        })
        i = textStart = close + n
        continue
      }
    }
    // 链接与图片：[文字](地址) / ![说明](地址)
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const lb = c === '!' ? i + 1 : i
      const rb = matchBracket(text, lb, to)
      if (rb > 0 && text[rb + 1] === '(') {
        const rp = text.indexOf(')', rb + 2)
        if (rp > 0 && rp < to && !/\s/.test(text.slice(rb + 2, rp).trim().replace(/ ".*"$/, ''))) {
          flush(i)
          out.push({
            k: 'link',
            from: i,
            to: rp + 1,
            href: text.slice(rb + 2, rp).trim(),
            children: [
              { k: 'mark', from: i, to: lb + 1 },
              ...parseInline(text, lb + 1, rb),
              { k: 'mark', from: rb, to: rp + 1 },
            ],
          })
          i = textStart = rp + 1
          continue
        }
      }
    }
    // 强调与删除线
    const d = DELIMS.find((x) => text.startsWith(x.open, i))
    if (d && canOpen(text, i, d.open, to)) {
      const close = findClose(text, i + d.open.length, to, d.open)
      if (close > 0) {
        flush(i)
        const n = d.open.length
        out.push({
          k: d.kind,
          from: i,
          to: close + n,
          children: [{ k: 'mark', from: i, to: i + n }, ...parseInline(text, i + n, close), { k: 'mark', from: close, to: close + n }],
        })
        i = textStart = close + n
        continue
      }
    }
    i++
  }
  flush(to)
  return out
}

function matchBracket(text: string, open: number, to: number): number {
  let depth = 0
  for (let i = open; i < to; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (text[i] === '[') depth++
    else if (text[i] === ']' && --depth === 0) return i
  }
  return -1
}

function canOpen(text: string, i: number, open: string, to: number): boolean {
  const next = text[i + open.length]
  if (next === undefined || i + open.length >= to || /\s/.test(next)) return false
  // 单个 * / _ 后面紧跟同一个符号：留给 ** / __ 处理
  if (open.length === 1 && next === open) return false
  // 下划线在单词中间不算（snake_case）
  if (open[0] === '_' && i > 0 && WORD.test(text[i - 1])) return false
  return true
}

function findClose(text: string, from: number, to: number, open: string): number {
  for (let j = from + 1; j + open.length <= to; j++) {
    if (text[j] === '\\') {
      j++
      continue
    }
    if (text[j] === '`') {
      // 跳过行内代码
      const close = text.indexOf('`', j + 1)
      if (close > 0 && close < to) j = close
      continue
    }
    if (!text.startsWith(open, j)) continue
    if (/\s/.test(text[j - 1])) continue
    if (open.length === 1 && (text[j + 1] === open || text[j - 1] === open)) continue
    if (open[0] === '_' && WORD.test(text[j + open.length] ?? '')) continue
    return j
  }
  return -1
}

/* ── 表格 ─────────────────────────────────────────── */

/** 一行里没有被反斜杠转义的竖线位置（相对行首） */
function pipesOf(line: string): number[] {
  const out: number[] = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === '|') out.push(i)
  }
  return out
}

/** 按竖线切开的各格原文（首尾的空格不算格） */
function cellTexts(line: string): string[] {
  const cuts = pipesOf(line)
  if (!cuts.length) return []
  const parts: string[] = []
  let at = 0
  for (const p of [...cuts, line.length]) {
    parts.push(line.slice(at, p))
    at = p + 1
  }
  if (!parts[0].trim()) parts.shift()
  if (parts.length && !parts[parts.length - 1].trim()) parts.pop()
  return parts
}

/** 表头下面的分隔行：| --- | :---: | ---: |，返回各列的对齐方式 */
export function delimAligns(line: string): (CellAlign | undefined)[] | null {
  if (!line.includes('|')) return null
  const cells = cellTexts(line).map((c) => c.trim())
  if (!cells.length || !cells.every((c) => /^:?-+:?$/.test(c))) return null
  return cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined))
}

/** 表格一行的节点：竖线与格子两边的空白是标记，格子里照常解析行内语法 */
function rowChildren(text: string, from: number, to: number, aligns: (CellAlign | undefined)[]): Inline[] {
  const line = text.slice(from, to)
  const cuts = pipesOf(line).map((p) => from + p)
  const segments: [number, number][] = []
  let at = from
  for (const p of [...cuts, to]) {
    segments.push([at, p])
    at = p + 1
  }
  const out: Inline[] = []
  let markStart = from
  let col = 0
  segments.forEach(([s, e], idx) => {
    const edge = idx === 0 || idx === segments.length - 1
    if (edge && !text.slice(s, e).trim()) return
    let cs = s
    let ce = e
    while (cs < ce && /\s/.test(text[cs])) cs++
    while (ce > cs && /\s/.test(text[ce - 1])) ce--
    if (cs > markStart) out.push({ k: 'mark', from: markStart, to: cs })
    out.push({ k: 'cell', from: cs, to: ce, children: ce > cs ? parseInline(text, cs, ce) : [], align: aligns[col++] })
    markStart = ce
  })
  if (to > markStart) out.push({ k: 'mark', from: markStart, to })
  return out
}

interface TableSpan {
  /** 表头行的下标，分隔行是 head + 1，数据行到 end（不含） */
  head: number
  end: number
  aligns: (CellAlign | undefined)[]
}

/** 找出一段里所有的表格：表头行与分隔行的列数相同才算 */
function findTables(raw: string[]): TableSpan[] {
  const out: TableSpan[] = []
  for (let i = 0; i + 1 < raw.length; i++) {
    const aligns = delimAligns(raw[i + 1])
    if (!aligns || !raw[i].includes('|') || cellTexts(raw[i]).length !== aligns.length) continue
    let end = i + 2
    while (end < raw.length && raw[end].trim() && raw[end].includes('|')) end++
    out.push({ head: i, end, aligns })
    i = end - 1
  }
  return out
}

/* ── 行 ───────────────────────────────────────────── */

const FENCE = /^ {0,3}(`{3,}|~{3,})/

export function parseMarkdown(text: string): MdBlock {
  const lines: MdLine[] = []
  let pos = 0
  const raw = text.split('\n')
  const fenced = FENCE.exec(raw[0] ?? '')
  let plain = !fenced
  const tables = fenced ? [] : findTables(raw)
  const tableAt = (idx: number) => tables.findIndex((t) => idx >= t.head && idx < t.end)
  raw.forEach((line, idx) => {
    const from = pos
    const to = pos + line.length
    pos = to + 1
    const t = tableAt(idx)
    if (t >= 0) {
      const span = tables[t]
      plain = false
      if (idx === span.head + 1) {
        lines.push({ kind: 'tdelim', from, to, prefixEnd: from, table: t, children: to > from ? [{ k: 'mark', from, to }] : [] })
      } else {
        const header = idx === span.head
        lines.push({ kind: 'tr', from, to, prefixEnd: from, table: t, header: header || undefined, children: rowChildren(text, from, to, span.aligns) })
      }
      return
    }
    if (fenced) {
      const isFence = idx === 0 || (idx === raw.length - 1 && line.trim().startsWith(fenced[1][0].repeat(3)))
      lines.push({ kind: isFence ? 'fence' : 'code', from, to, prefixEnd: isFence ? to : from, children: isFence ? [] : [{ k: 'text', from, to }] })
      return
    }
    let m: RegExpExecArray | null
    let kind: LineKind = 'p'
    let prefixEnd = from
    let level: number | undefined
    let indent: number | undefined
    if ((m = /^( *)([-*+]) +/.exec(line)) && !/^ *([-*_])( *\1){2,} *$/.test(line)) {
      kind = 'ul'
      prefixEnd = from + m[0].length
      indent = Math.floor(m[1].length / 2)
    } else if ((m = /^( *)(\d{1,9})([.)]) +/.exec(line))) {
      kind = 'ol'
      prefixEnd = from + m[0].length
      level = Number(m[2])
      indent = Math.floor(m[1].length / 2)
    } else if ((m = /^ {0,3}> ?/.exec(line))) {
      kind = 'quote'
      prefixEnd = from + m[0].length
    } else if ((m = /^ {0,3}(#{1,6}) +/.exec(line))) {
      kind = 'h'
      prefixEnd = from + m[0].length
      level = m[1].length
    } else if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) {
      kind = 'hr'
      prefixEnd = to
    }
    const children = prefixEnd < to ? parseInline(text, prefixEnd, to) : []
    if (kind !== 'p' || children.some((c) => c.k !== 'text')) plain = false
    lines.push({ kind, from, to, prefixEnd, level, indent, children })
  })
  return { lines, plain }
}

/* ── 格式操作（格式浮条与快捷键用） ─────────────────── */

export interface Edit {
  /** 替换 [from, to) */
  from: number
  to: number
  insert: string
  /** 替换后的选区 */
  selStart: number
  selEnd: number
}

export type WrapFormat = 'strong' | 'em' | 'del' | 'code'
export const WRAP_MARKER: Record<WrapFormat, string> = { strong: '**', em: '*', del: '~~', code: '`' }

/**
 * 给选中的文字加上 / 去掉成对标记。已经包着同样标记（在选区外侧或就在选区两端）时去掉；
 * 选区为空时插入一对标记，光标放在中间。
 */
export function toggleWrap(text: string, start: number, end: number, format: WrapFormat): Edit {
  const m = WRAP_MARKER[format]
  const n = m.length
  const sel = text.slice(start, end)
  const outside = text.slice(start - n, start) === m && text.slice(end, end + n) === m && !isLonger(text, start - n, end + n, m, format)
  if (start < end && outside) {
    return { from: start - n, to: end + n, insert: sel, selStart: start - n, selEnd: end - n }
  }
  if (sel.length >= 2 * n && sel.startsWith(m) && sel.endsWith(m) && !(format === 'em' && sel.startsWith('**'))) {
    const inner = sel.slice(n, sel.length - n)
    return { from: start, to: end, insert: inner, selStart: start, selEnd: start + inner.length }
  }
  // 选区两端的空白留在标记外面（"** 粗**"不是合法的加粗）
  const lead = sel.length - sel.trimStart().length
  const trail = sel.length - sel.trimEnd().length
  const core = sel.trim()
  if (!core) return { from: start, to: end, insert: sel + m + m, selStart: end + n, selEnd: end + n }
  const insert = sel.slice(0, lead) + m + core + m + sel.slice(sel.length - trail)
  return { from: start, to: end, insert, selStart: start + lead + n, selEnd: start + lead + n + core.length }
}

/** 斜体的 * 其实是加粗 ** 的一部分 */
function isLonger(text: string, a: number, b: number, m: string, format: WrapFormat): boolean {
  return format === 'em' && (text[a - 1] === m || text[b] === m)
}

/** [选中的文字](https://)，选中地址方便直接输入 */
export function makeLink(text: string, start: number, end: number): Edit {
  const label = text.slice(start, end) || '链接文字'
  const url = 'https://'
  const insert = `[${label}](${url})`
  const urlStart = start + label.length + 3
  return { from: start, to: end, insert, selStart: urlStart, selEnd: urlStart + url.length }
}

export type LineFormat = 'ul' | 'ol' | 'quote'

const LINE_PREFIX: Record<LineFormat, RegExp> = {
  ul: /^( *)[-*+] +/,
  ol: /^( *)\d{1,9}[.)] +/,
  quote: /^ {0,3}> ?/,
}

/** 选区涉及的每一行加上 / 去掉列表符号或引用符号；都已经有了就去掉 */
export function toggleLines(text: string, start: number, end: number, format: LineFormat): Edit {
  const from = text.lastIndexOf('\n', start - 1) + 1
  const nl = text.indexOf('\n', Math.max(end - (end > start && text[end - 1] === '\n' ? 1 : 0), start))
  const to = nl < 0 ? text.length : nl
  const lines = text.slice(from, to).split('\n')
  const re = LINE_PREFIX[format]
  const all = lines.every((l) => re.test(l))
  const strip = (l: string) => l.replace(LINE_PREFIX.ul, '$1').replace(LINE_PREFIX.ol, '$1').replace(LINE_PREFIX.quote, '')
  const next = lines.map((l, i) => {
    if (all) return l.replace(re, format === 'quote' ? '' : '$1')
    const body = strip(l)
    return format === 'ul' ? `- ${body}` : format === 'ol' ? `${i + 1}. ${body}` : `> ${body}`
  })
  const insert = next.join('\n')
  return { from, to, insert, selStart: from, selEnd: from + insert.length }
}

export function applyEdit(text: string, e: Edit): string {
  return text.slice(0, e.from) + e.insert + text.slice(e.to)
}

/* ── 表格编辑 ─────────────────────────────────────── */

/** 空表格：两列，表头写着"列 1""列 2"，下面一行空数据 */
export const TABLE_TEMPLATE = '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |'

function emptyRow(cols: number): string {
  return '|' + '  |'.repeat(Math.max(1, cols))
}

/**
 * 编辑时在表格里按回车：
 * - 在表头或数据行里：在下面加一行空行，光标进第一格（在表头按回车时加在分隔行下面）；
 * - 在最后一行、而且这一行是空的：去掉这行空行，表示表格写完了（exit，由调用方接着分段）。
 * 不在表格里返回 null。
 */
export function tableEnter(
  text: string,
  start: number,
  end: number
): { kind: 'row'; edit: Edit } | { kind: 'exit'; text: string; caret: number } | null {
  if (start !== end) return null
  const block = parseMarkdown(text)
  const i = block.lines.findIndex((l) => start >= l.from && start <= l.to)
  const line = block.lines[i]
  if (!line || (line.kind !== 'tr' && line.kind !== 'tdelim')) return null
  const rows = block.lines.filter((l) => l.table === line.table)
  const cols = rows.find((l) => l.kind === 'tr')?.children.filter((c) => c.k === 'cell').length ?? 2
  const last = rows[rows.length - 1]
  const blank = line.kind === 'tr' && !line.header && line.children.every((c) => c.k !== 'cell' || c.to === c.from)
  if (line === last && blank && rows.length > 2) {
    // 去掉这行空行（连同它前面的换行），光标停在表格末尾
    const cut = line.from - 1
    return { kind: 'exit', text: text.slice(0, cut) + text.slice(line.to), caret: cut }
  }
  const after = line.header ? block.lines[i + 1] : line
  const at = after.to
  const insert = '\n' + emptyRow(cols)
  return { kind: 'row', edit: { from: at, to: at, insert, selStart: at + 3, selEnd: at + 3 } }
}

/**
 * 从 Excel / WPS / 网页表格复制来的文字（每行用制表符分列）转成 Markdown 表格，第一行当表头。
 * 不像表格（少于两行，或各行列数不一）返回 null。
 */
export function tsvToTable(raw: string): string | null {
  const rows = raw.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  if (rows.length < 2 || !rows.every((r) => r.includes('\t'))) return null
  const cells = rows.map((r) => r.split('\t').map((c) => c.trim().replace(/\|/g, '\\|')))
  const cols = cells[0].length
  if (!cells.every((r) => r.length === cols)) return null
  const line = (r: string[]) => `| ${r.map((c) => c || ' ').join(' | ')} |`
  return [line(cells[0]), `| ${Array(cols).fill('---').join(' | ')} |`, ...cells.slice(1).map(line)].join('\n')
}

/** 表格所在的行（[起, 止) 偏移，不含换行）：AI 味检查等只看行文的地方用来跳过表格 */
export function tableLineRanges(text: string): [number, number][] {
  if (!text.includes('|')) return []
  const raw = text.split('\n')
  if (FENCE.test(raw[0] ?? '')) return []
  const starts: number[] = []
  let pos = 0
  for (const l of raw) {
    starts.push(pos)
    pos += l.length + 1
  }
  return findTables(raw).flatMap((t) => {
    const out: [number, number][] = []
    for (let i = t.head; i < t.end; i++) out.push([starts[i], starts[i] + raw[i].length])
    return out
  })
}

/** 表格行换成等长的空白：偏移不变，统计时不算 */
export function maskTables(text: string): string {
  const ranges = tableLineRanges(text)
  if (!ranges.length) return text
  let out = ''
  let at = 0
  for (const [s, e] of ranges) {
    out += text.slice(at, s) + ' '.repeat(e - s)
    at = e
  }
  return out + text.slice(at)
}

/** 去掉表格行（连同多出来的空行） */
export function stripTables(text: string): string {
  const ranges = tableLineRanges(text)
  if (!ranges.length) return text
  const drop = new Set(ranges.map(([s]) => s))
  let pos = 0
  return text
    .split('\n')
    .filter((l) => {
      const keep = !drop.has(pos)
      pos += l.length + 1
      return keep
    })
    .join('\n')
    .trim()
}

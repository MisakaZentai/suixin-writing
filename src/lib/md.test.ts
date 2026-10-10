import { describe, expect, it } from 'vitest'
import {
  TABLE_TEMPLATE,
  applyEdit,
  makeLink,
  maskTables,
  parseInline,
  parseMarkdown,
  stripTables,
  tableEnter,
  toggleLines,
  toggleWrap,
  tsvToTable,
  type Inline,
  type MdBlock,
} from './md'

/** 所有叶子节点按顺序拼起来（行之间补换行）必须逐字还原源文字 */
function rebuild(text: string, b: MdBlock): string {
  const leaves = (xs: Inline[]): string => xs.map((x) => ('children' in x ? leaves(x.children) : text.slice(x.from, x.to))).join('')
  return b.lines.map((l) => text.slice(l.from, l.prefixEnd) + leaves(l.children)).join('\n')
}

/** 简写：只看结构 */
function shape(text: string, xs: Inline[]): unknown[] {
  return xs.map((x) => ('children' in x ? { [x.k]: shape(text, x.children) } : x.k === 'mark' ? `<${text.slice(x.from, x.to)}>` : text.slice(x.from, x.to)))
}

const CASES = [
  '纯文字，没有任何语法。',
  '这是**加粗**、*斜体*、~~删除~~和`代码`。',
  '[链接](https://example.com)与![图](a.png)',
  '- 第一项\n- 第二项 **粗**\n  - 子项',
  '1. 一\n2. 二',
  '> 引用一行\n> 引用 *两行*',
  '```js\nconst a = 1\n\nconsole.log(a)\n```',
  'snake_case_name 与 2*3*4 与 a ** b',
  '转义 \\*不是斜体\\* 与 `**不解析**`',
  '---',
  '未闭合的 **粗 与 [链接',
  '| 模型 | 用时 |\n| --- | :---: |\n| **mimo** | 2h40m |\n| ds |  |',
  '前一句\n模型 | 用时\n--- | ---\nmimo | 2h\n后一句',
  '| 转义 \\| 竖线 | b |\n|---|---|\n| `a|b` | c |',
]

describe('Markdown 模式的解析', () => {
  it.each(CASES)('逐字还原：%s', (text) => {
    expect(rebuild(text, parseMarkdown(text))).toBe(text)
  })

  it('行内：加粗、斜体、删除线、代码、链接', () => {
    const t = '这是**加粗**、*斜体*、~~删~~、`c`、[链](u)'
    expect(shape(t, parseInline(t, 0, t.length))).toEqual([
      '这是',
      { strong: ['<**>', '加粗', '<**>'] },
      '、',
      { em: ['<*>', '斜体', '<*>'] },
      '、',
      { del: ['<~~>', '删', '<~~>'] },
      '、',
      { code: ['<`>', 'c', '<`>'] },
      '、',
      { link: ['<[>', '链', '<](u)>'] },
    ])
  })

  it('不是强调的星号与下划线', () => {
    // 注意：2*3*4 在 CommonMark 里是斜体（星号可以用在词中间，下划线不行），与导出一致
    for (const t of ['snake_case_name', 'a ** b', '未闭合 **粗', 'a * b']) {
      expect(parseMarkdown(t).plain, t).toBe(true)
    }
  })

  it('嵌套：加粗里的斜体、链接文字里的加粗；代码里不解析', () => {
    const t = '**粗*斜*粗** [**粗链**](u) `**不解析**`'
    const s = shape(t, parseInline(t, 0, t.length))
    expect(s[0]).toEqual({ strong: ['<**>', '粗', { em: ['<*>', '斜', '<*>'] }, '粗', '<**>'] })
    expect(s[2]).toEqual({ link: ['<[>', { strong: ['<**>', '粗链', '<**>'] }, '<](u)>'] })
    expect(s[4]).toEqual({ code: ['<`>', '**不解析**', '<`>'] })
  })

  it('行：列表、有序列表、引用、标题、分割线、代码块', () => {
    const kinds = (t: string) => parseMarkdown(t).lines.map((l) => l.kind)
    expect(kinds('- a\n* b\n+ c')).toEqual(['ul', 'ul', 'ul'])
    expect(kinds('1. a\n2) b')).toEqual(['ol', 'ol'])
    expect(parseMarkdown('3. 三').lines[0].level).toBe(3)
    expect(kinds('> a\nb')).toEqual(['quote', 'p'])
    expect(kinds('## 小标题')).toEqual(['h'])
    expect(kinds('***')).toEqual(['hr'])
    expect(kinds('```\n- 不是列表\n```')).toEqual(['fence', 'code', 'fence'])
    expect(parseMarkdown('普通的两行\n第二行').plain).toBe(true)
  })

  // 这两条来自 main 上的管道表格实现（3f2d966），合并时改写成本分支表格的数据结构（tr + cell）
  const cellsOf = (t: string, l: MdBlock['lines'][number]) =>
    l.children.flatMap((c) => (c.k === 'cell' ? [t.slice(c.from, c.to)] : []))
  const alignsOf = (l: MdBlock['lines'][number]) => l.children.flatMap((c) => (c.k === 'cell' ? [c.align] : []))

  it('表格：表头、分隔行、表体、单元格与对齐', () => {
    const t = '| 名称 | 数量 |\n|:-----|-----:|\n| 苹果 | **3** |\n| 梨 | 12 |'
    const b = parseMarkdown(t)
    expect(b.plain).toBe(false)
    expect(b.lines.map((l) => l.kind)).toEqual(['tr', 'tdelim', 'tr', 'tr'])
    expect(cellsOf(t, b.lines[0])).toEqual(['名称', '数量'])
    expect(cellsOf(t, b.lines[2])).toEqual(['苹果', '**3**'])
    expect(alignsOf(b.lines[0])).toEqual(['left', 'right'])
    expect(alignsOf(b.lines[3])).toEqual(['left', 'right'])
    expect(rebuild(t, b)).toBe(t)
  })

  it('表格：转义的竖线不拆格；没有分隔行就只是普通文字', () => {
    const t = '| a \\| b | c |\n|---|---|\n| d | e |'
    const b = parseMarkdown(t)
    expect(cellsOf(t, b.lines[0])).toEqual(['a \\| b', 'c'])
    expect(parseMarkdown('| a | b |').plain).toBe(true)
    expect(parseMarkdown('| a |\n| b |').plain).toBe(true)
  })
})

describe('格式操作', () => {
  const run = (t: string, s: number, e: number, f: Parameters<typeof toggleWrap>[3]) => {
    const edit = toggleWrap(t, s, e, f)
    const next = applyEdit(t, edit)
    return { text: next, sel: next.slice(edit.selStart, edit.selEnd) }
  }

  it('加粗：加上、再点一次去掉（选区在标记里面或包含标记都行）', () => {
    expect(run('雨停了', 0, 2, 'strong')).toEqual({ text: '**雨停**了', sel: '雨停' })
    expect(run('**雨停**了', 2, 4, 'strong')).toEqual({ text: '雨停了', sel: '雨停' })
    expect(run('**雨停**了', 0, 6, 'strong')).toEqual({ text: '雨停了', sel: '雨停' })
  })

  it('选区两端的空白留在标记外面；空选区插入一对标记', () => {
    expect(run('a b c', 1, 4, 'em')).toEqual({ text: 'a *b* c', sel: 'b' })
    const e = toggleWrap('ab', 1, 1, 'code')
    expect(applyEdit('ab', e)).toBe('a``b')
    expect(e.selStart).toBe(2)
  })

  it('斜体不会把加粗拆开', () => {
    expect(run('**粗**', 2, 3, 'em').text).toBe('***粗***')
  })

  it('链接：选中地址等着输入', () => {
    const e = makeLink('看这里', 0, 3)
    const next = applyEdit('看这里', e)
    expect(next).toBe('[看这里](https://)')
    expect(next.slice(e.selStart, e.selEnd)).toBe('https://')
  })

  it('列表与引用：作用于选区涉及的每一行，再点一次去掉', () => {
    const t = '甲\n乙\n丙'
    const ul = applyEdit(t, toggleLines(t, 0, 3, 'ul'))
    expect(ul).toBe('- 甲\n- 乙\n丙')
    expect(applyEdit(ul, toggleLines(ul, 0, 6, 'ul'))).toBe(t)
    expect(applyEdit(t, toggleLines(t, 2, 5, 'ol'))).toBe('甲\n1. 乙\n2. 丙')
    expect(applyEdit(ul, toggleLines(ul, 0, 0, 'quote'))).toBe('> 甲\n- 乙\n丙')
  })
})

describe('表格', () => {
  const kinds = (t: string) => parseMarkdown(t).lines.map((l) => l.kind)
  const cells = (t: string, line: number) =>
    parseMarkdown(t)
      .lines[line].children.filter((c) => c.k === 'cell')
      .map((c) => t.slice(c.from, c.to))

  it('表头 + 分隔行 + 数据行；列数对不上、没有分隔行都不算表格', () => {
    const t = '| 模型 | 用时 |\n| --- | ---: |\n| mimo | 2h40m |\n| ds |  |\n表格后面的话'
    expect(kinds(t)).toEqual(['tr', 'tdelim', 'tr', 'tr', 'p'])
    expect(parseMarkdown(t).lines[0].header).toBe(true)
    expect(cells(t, 2)).toEqual(['mimo', '2h40m'])
    expect(cells(t, 3)).toEqual(['ds', '']) // 空格子也占一列
    const aligns = parseMarkdown(t).lines[2].children.flatMap((c) => (c.k === 'cell' ? [c.align] : []))
    expect(aligns).toEqual([undefined, 'right'])
    expect(kinds('a | b\nc | d')).toEqual(['p', 'p'])
    expect(kinds('| a | b | c |\n| --- | --- |')).toEqual(['p', 'p'])
    expect(kinds('---')).toEqual(['hr'])
    expect(kinds('```\n| a |\n|---|\n```')).toEqual(['fence', 'code', 'code', 'fence'])
  })

  it('没有首尾竖线也行；转义的竖线不分格；格子里照常有行内语法', () => {
    expect(cells('a | b\n--- | ---\nc | d', 2)).toEqual(['c', 'd'])
    expect(cells('| x \\| y | z |\n|---|---|', 0)).toEqual(['x \\| y', 'z'])
    const first = parseMarkdown('| **粗** | b |\n|---|---|').lines[0].children.find((c) => c.k === 'cell')
    expect(first && 'children' in first ? first.children[0].k : null).toBe('strong')
  })

  it('回车：加一行；在表头按加在分隔行下面；最后一行空着再按就结束表格', () => {
    const t = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    const inRow = tableEnter(t, t.length, t.length)
    if (inRow?.kind !== 'row') throw new Error('应当加一行')
    const added = applyEdit(t, inRow.edit)
    expect(added).toBe(t + '\n|  |  |')
    expect(added.slice(0, inRow.edit.selStart).endsWith('\n| ')).toBe(true)
    const inHead = tableEnter(t, 3, 3)
    expect(inHead?.kind === 'row' ? applyEdit(t, inHead.edit) : null).toBe('| a | b |\n| --- | --- |\n|  |  |\n| 1 | 2 |')
    expect(tableEnter(added, added.length - 2, added.length - 2)).toEqual({ kind: 'exit', text: t, caret: t.length })
    expect(tableEnter('普通的一段', 2, 2)).toBeNull()
    expect(tableEnter(t, 0, 3)).toBeNull() // 有选区时照常分段
    expect(kinds(TABLE_TEMPLATE)).toEqual(['tr', 'tdelim', 'tr'])
  })

  it('从表格软件复制的格子转成 Markdown 表格', () => {
    expect(tsvToTable('模型\t用时\r\nmimo\t2h\r\nds\t\r\n')).toBe('| 模型 | 用时 |\n| --- | --- |\n| mimo | 2h |\n| ds |   |')
    expect(tsvToTable('a|b\tc\nd\te')).toBe('| a\\|b | c |\n| --- | --- |\n| d | e |')
    expect(tsvToTable('只有一行\t两列')).toBeNull()
    expect(tsvToTable('a\tb\nc')).toBeNull()
    expect(tsvToTable('普通文字\n第二行')).toBeNull()
  })

  it('跳过表格：换成等长空白 / 整行去掉', () => {
    const t = '前面的话。\n| a | b |\n|---|---|\n| 1 | 2 |\n后面的话。'
    const masked = maskTables(t)
    expect(masked.length).toBe(t.length)
    expect(masked.replace(/\s+/g, '')).toBe('前面的话。后面的话。')
    expect(stripTables(t)).toBe('前面的话。\n后面的话。')
    expect(stripTables('没有表格 | 只是竖线')).toBe('没有表格 | 只是竖线')
  })
})

import { describe, expect, it } from 'vitest'
import { applyEdit, makeLink, parseInline, parseMarkdown, toggleLines, toggleWrap, type Inline, type MdBlock } from './md'

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

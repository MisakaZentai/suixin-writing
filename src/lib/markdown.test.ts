import { describe, expect, it } from 'vitest'
import { parseDocument, toMarkdown } from './markdown'

const SAMPLE = `# 没有雨的城市

## 引言

在这座城市里，雨是一种被审计的液体。每一滴水的下落都要经过市政厅的批准。

## 水的经济学

城里流通两种货币。

### 黑市

水票不记名、不挂失。
`

function roundTrip(md: string): string {
  const parsed = parseDocument(md)
  return toMarkdown({ title: parsed.title ?? '', titleAsHeading: parsed.title !== null }, parsed.blocks)
}

describe('parseDocument', () => {
  it('文首唯一一级标题成为文稿标题，其余标题层级原样保留', () => {
    const { title, blocks } = parseDocument(SAMPLE)
    expect(title).toBe('没有雨的城市')
    const headings = blocks.filter((b) => b.type === 'heading')
    expect(headings.map((h) => [h.text, h.type === 'heading' && h.level])).toEqual([
      ['引言', 2],
      ['水的经济学', 2],
      ['黑市', 3],
    ])
  })

  it('规范化 Markdown 导入后原样导出逐字节一致', () => {
    expect(roundTrip(SAMPLE)).toBe(SAMPLE)
  })

  it('段内换行、行首缩进保留', () => {
    const md = '# 标题\n\n　　第一行\n第二行  \n第三行\n'
    expect(roundTrip(md)).toBe(md)
  })

  it('代码围栏内不识别标题、不按空行切分', () => {
    const md = '# 标题\n\n```bash\n# 注释\n\necho hi\n```\n'
    const { blocks } = parseDocument(md)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('paragraph')
    expect(roundTrip(md)).toBe(md)
  })

  it('多个一级标题时不吞掉第一章，导出也不重复标题', () => {
    const md = '# 第一章\n\n正文一。\n\n# 第二章\n\n正文二。\n'
    const { title, blocks } = parseDocument(md)
    expect(title).toBe('第一章')
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1, text: '第一章' })
    expect(roundTrip(md)).toBe(md)
  })

  it('没有空行的多行文本按一行一段处理', () => {
    const { blocks } = parseDocument('第一段。\n第二段。\n第三段。')
    expect(blocks.map((b) => b.text)).toEqual(['第一段。', '第二段。', '第三段。'])
  })

  it('没有空行的列表保持为一段', () => {
    const { blocks } = parseDocument('- 一\n- 二\n- 三')
    expect(blocks).toHaveLength(1)
  })

  it('没有标题的文本导出时不凭空加标题', () => {
    const md = '第一段。\n\n第二段。\n'
    expect(roundTrip(md)).toBe(md)
  })

  it('去掉标题行尾的闭合井号', () => {
    const { blocks } = parseDocument('## 小节 ##\n\n正文')
    expect(blocks[0].text).toBe('小节')
  })
})

import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import type { HeadingBlock, ProjectData } from '../types'
import {
  addSuggestion,
  applySuggestion,
  buildOutline,
  convertBlock,
  editBlock,
  headingPaths,
  isStale,
  mergeWithPrevious,
  moveSection,
  rollback,
  sectionBodyIds,
  shiftSectionLevel,
  splitParagraph,
  targetText,
} from './doc'
import { projectFromText } from './project'

const MD = `# 文稿

## 一

段一甲。段一乙。

段一丙。

### 一之一

段一一。

## 二

段二。
`

function fresh(): ProjectData {
  return projectFromText(MD).project
}

function texts(d: ProjectData): string[] {
  return d.blocks.map((b) => (b.type === 'heading' ? `${'#'.repeat(b.level)} ${b.text}` : b.text))
}

function idOf(d: ProjectData, text: string): string {
  const b = d.blocks.find((x) => x.text === text)
  if (!b) throw new Error(`找不到块：${text}`)
  return b.id
}

describe('段落编辑与版本', () => {
  it('回退到导入版本只恢复这一段，历史保留', () => {
    let d = fresh()
    const id = idOf(d, '段一甲。段一乙。')
    d = produce(d, (x) => void editBlock(x, id, '段一甲。段一乙。（补一句）'))
    d = produce(d, (x) => void rollback(x, id, 0))
    const b = d.blocks.find((x) => x.id === id)!
    expect(b.text).toBe('段一甲。段一乙。')
    expect(b.versions.map((v) => v.source)).toEqual(['import', 'manual', 'rollback'])
    expect(b.versions[2].instruction).toBe('v0')
    expect(d.blocks).toHaveLength(fresh().blocks.length)
  })

  it('文本未变不产生新版本', () => {
    const d = fresh()
    const id = idOf(d, '段二。')
    const next = produce(d, (x) => void editBlock(x, id, '段二。'))
    expect(next).toBe(d)
  })

  it('拆分：前半保留历史，后半成为新段落', () => {
    let d = fresh()
    const id = idOf(d, '段一甲。段一乙。')
    let newId = ''
    d = produce(d, (x) => void (newId = splitParagraph(x, id, 4)!))
    expect(texts(d).slice(1, 3)).toEqual(['段一甲。', '段一乙。'])
    expect(d.blocks[1].id).toBe(id)
    expect(d.blocks[2].id).toBe(newId)
  })

  it('合并：与上一段拼接并返回接缝光标', () => {
    let d = fresh()
    const id = idOf(d, '段一丙。')
    let res: { id: string; caret: number } | null = null
    d = produce(d, (x) => void (res = mergeWithPrevious(x, id)))
    expect(res).toEqual({ id: idOf(d, '段一甲。段一乙。段一丙。'), caret: 8 })
    expect(texts(d)).toContain('段一甲。段一乙。段一丙。')
  })

  it('上一块是标题时不合并', () => {
    const d = fresh()
    const id = idOf(d, '段二。')
    const next = produce(d, (x) => void mergeWithPrevious(x, id))
    expect(next).toBe(d)
  })

  it('段落 ↔ 标题互转保留 id 与历史', () => {
    let d = fresh()
    const id = idOf(d, '段二。')
    d = produce(d, (x) => void convertBlock(x, id, 'heading', 3))
    const b = d.blocks.find((x) => x.id === id)!
    expect(b).toMatchObject({ type: 'heading', level: 3 })
    expect(b.versions.length).toBeGreaterThan(0)
  })
})

describe('大纲与章节', () => {
  it('大纲由标题派生', () => {
    const outline = buildOutline(fresh().blocks)
    expect(outline.map((n) => [n.title, n.children.map((c) => c.title)])).toEqual([
      ['一', ['一之一']],
      ['二', []],
    ])
  })

  it('标题路径', () => {
    const d = fresh()
    const paths = headingPaths(d.blocks)
    expect(paths.get(idOf(d, '段一一。'))!.map((h) => h.text)).toEqual(['一', '一之一'])
    expect(paths.get(idOf(d, '段二。'))!.map((h) => h.text)).toEqual(['二'])
  })

  it('章节正文只到下一个标题为止', () => {
    const d = fresh()
    expect(sectionBodyIds(d.blocks, idOf(d, '一'))).toEqual([
      idOf(d, '段一甲。段一乙。'),
      idOf(d, '段一丙。'),
    ])
  })

  it('整节移动到另一节之后，子节与正文一起走', () => {
    let d = fresh()
    d = produce(d, (x) => void moveSection(x, idOf(x, '一'), idOf(x, '二'), 'after'))
    expect(texts(d)).toEqual(['## 二', '段二。', '## 一', '段一甲。段一乙。', '段一丙。', '### 一之一', '段一一。'])
  })

  it('移入另一节内部时层级随之调整', () => {
    let d = fresh()
    d = produce(d, (x) => void moveSection(x, idOf(x, '二'), idOf(x, '一之一'), 'inside'))
    const h = d.blocks.find((b) => b.text === '二') as HeadingBlock
    expect(h.level).toBe(4)
    expect(texts(d).slice(-2)).toEqual(['#### 二', '段二。'])
  })

  it('不能移进自己的子节', () => {
    const d = fresh()
    const next = produce(d, (x) => void moveSection(x, idOf(x, '一'), idOf(x, '一之一'), 'inside'))
    expect(next).toBe(d)
  })

  it('整节降级', () => {
    let d = fresh()
    d = produce(d, (x) => void shiftSectionLevel(x, idOf(x, '一'), 1))
    expect(texts(d).filter((t) => t.startsWith('#'))).toEqual(['### 一', '#### 一之一', '## 二'])
  })
})

describe('建议', () => {
  it('段落级建议：接受后替换并记入版本历史', () => {
    let d = fresh()
    const id = idOf(d, '段二。')
    let sid = ''
    d = produce(d, (x) => {
      sid = addSuggestion(x, {
        kind: 'ai_diff',
        target: { blockIds: [id] },
        instruction: null,
        original: '段二。',
        proposed: '第二段。',
      })
    })
    expect(isStale(d, d.suggestions[0])).toBe(false)
    d = produce(d, (x) => void applySuggestion(x, sid, '第二段。'))
    const b = d.blocks.find((x) => x.id === id)!
    expect(b.text).toBe('第二段。')
    expect(b.versions[b.versions.length - 1].source).toBe('ai_rewrite')
    expect(d.suggestions[0].state).toBe('accepted')
  })

  it('原文被改动后建议过期，拒绝落地', () => {
    let d = fresh()
    const id = idOf(d, '段二。')
    let sid = ''
    d = produce(d, (x) => {
      sid = addSuggestion(x, {
        kind: 'ai_diff',
        target: { blockIds: [id] },
        instruction: null,
        original: '段二。',
        proposed: '第二段。',
      })
    })
    d = produce(d, (x) => void editBlock(x, id, '段二改过了。'))
    expect(isStale(d, d.suggestions[0])).toBe(true)
    let res: string[] | null = []
    d = produce(d, (x) => void (res = applySuggestion(x, sid, '第二段。')))
    expect(res).toBeNull()
    expect(d.blocks.find((x) => x.id === id)!.text).toBe('段二改过了。')
  })

  it('段内片段建议只替换片段', () => {
    let d = fresh()
    const id = idOf(d, '段一甲。段一乙。')
    let sid = ''
    d = produce(d, (x) => {
      sid = addSuggestion(x, {
        kind: 'ai_diff',
        target: { blockIds: [id], range: [4, 8] },
        instruction: '改写',
        original: '段一乙。',
        proposed: '第二句。',
      })
    })
    expect(targetText(d, d.suggestions[0].target)).toBe('段一乙。')
    d = produce(d, (x) => void applySuggestion(x, sid, '第二句。'))
    expect(d.blocks.find((x) => x.id === id)!.text).toBe('段一甲。第二句。')
  })

  it('多段建议：按空行重新分段，多出的段落插入、少了的删除', () => {
    let d = fresh()
    const ids = [idOf(d, '段一甲。段一乙。'), idOf(d, '段一丙。')]
    let sid = ''
    d = produce(d, (x) => {
      sid = addSuggestion(x, {
        kind: 'ai_diff',
        target: { blockIds: ids },
        instruction: '扩写',
        original: '段一甲。段一乙。\n\n段一丙。',
        proposed: 'A。\n\nB。\n\nC。',
      })
    })
    d = produce(d, (x) => void applySuggestion(x, sid, 'A。\n\nB。\n\nC。'))
    expect(texts(d).slice(0, 5)).toEqual(['## 一', 'A。', 'B。', 'C。', '### 一之一'])
    expect(d.blocks[1].id).toBe(ids[0])
  })

  it('插入型建议：插在指定块之后', () => {
    let d = fresh()
    const after = idOf(d, '二')
    let sid = ''
    d = produce(d, (x) => {
      sid = addSuggestion(x, {
        kind: 'ai_diff',
        target: { blockIds: [], insertAfter: after },
        instruction: '续写',
        original: '',
        proposed: '新段落。',
      })
    })
    d = produce(d, (x) => void applySuggestion(x, sid, '新段落。'))
    expect(texts(d).slice(-3)).toEqual(['## 二', '新段落。', '段二。'])
  })

  it('同一位置的新建议让旧的待处理建议作废', () => {
    let d = fresh()
    const id = idOf(d, '段二。')
    const input = {
      kind: 'ai_diff' as const,
      target: { blockIds: [id] },
      instruction: null,
      original: '段二。',
      proposed: 'x',
    }
    d = produce(d, (x) => void addSuggestion(x, input))
    d = produce(d, (x) => void addSuggestion(x, { ...input, proposed: 'y' }))
    expect(d.suggestions.map((s) => s.state)).toEqual(['rejected', 'pending'])
  })
})

describe('变更集', () => {
  it('整组接受：按顺序落地，过期的跳过；整组放弃包括检查意见', async () => {
    const { acceptChangeset, rejectChangeset, addSuggestion, describeExternalChange } = await import('./doc')
    let d = fresh()
    const a = idOf(d, '段二。')
    const b = idOf(d, '段一丙。')
    d = produce(d, (x) => {
      addSuggestion(x, { kind: 'ai_diff', target: { blockIds: [a] }, instruction: null, original: '段二。', proposed: '第二段。', changeset: 'cs1', author: { kind: 'agent', name: 'Codex' } })
      addSuggestion(x, { kind: 'ai_diff', target: { blockIds: [b] }, instruction: null, original: '已经不是这个了', proposed: 'x', changeset: 'cs1' })
      addSuggestion(x, { kind: 'note', target: { blockIds: [b] }, instruction: '建议', original: '', proposed: '', changeset: 'cs2' })
    })
    const summary = describeExternalChange(fresh(), d)
    expect(summary.suggestionsBy).toEqual({ Codex: 1, 外部程序: 2 })
    let res = { applied: 0, stale: 0 }
    d = produce(d, (x) => void (res = acceptChangeset(x, 'cs1')))
    expect(res).toEqual({ applied: 1, stale: 1 })
    expect(texts(d)).toContain('第二段。')
    let n = 0
    d = produce(d, (x) => void (n = rejectChangeset(x, 'cs2')))
    expect(n).toBe(1)
    expect(d.suggestions.every((s) => s.state !== 'pending')).toBe(true)
  })
})

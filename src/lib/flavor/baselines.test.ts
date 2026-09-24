import { afterEach, describe, expect, it } from 'vitest'
import {
  baselineFromSources,
  parseBaselineStore,
  removeBaseline,
  resolveBaseline,
  serializeBaselineStore,
  setBaselineStore,
  setDefaultBaseline,
  sourceParagraphs,
  upsertBaseline,
} from './baselines'
import { analyzeProject } from './project'
import { projectFromText, serializeProject } from '../project'

const MINE = '风不是吹，而是推。雨不是下，而是砸。\n\n我把伞收起来，走进楼道。'.repeat(1)

afterEach(() => setBaselineStore({ version: 1, baselines: [] }))

describe('AI 味个人基线', () => {
  it('来源：工程文件取正文段落，Markdown / 纯文本按段切开（标题不算）', () => {
    expect(sourceParagraphs('a.md', '# 标题\n\n第一段。\n\n第二段。')).toEqual(['第一段。', '第二段。'])
    const { project } = projectFromText('## 一\n\n正文一。\n\n正文二。', '稿')
    expect(sourceParagraphs('稿.suixin.json', serializeProject(project))).toEqual(['正文一。', '正文二。'])
  })

  it('建立、存取、默认与删除', () => {
    const b = baselineFromSources('我', [{ name: 'a.txt', text: MINE }])
    expect(b.counts.neg_correction).toBe(2)
    expect(b.builtFrom).toEqual(['a.txt'])
    let store = upsertBaseline({ version: 1, baselines: [] }, b, true)
    expect(store.default).toBe('我')
    store = parseBaselineStore(serializeBaselineStore(store))
    expect(store.baselines.map((x) => x.name)).toEqual(['我'])
    expect(setDefaultBaseline(store, '内置').default).toBeUndefined()
    expect(removeBaseline(store, '我')).toEqual({ version: 1, baselines: [] })
    expect(parseBaselineStore('坏的 JSON')).toEqual({ version: 1, baselines: [] })
    expect(parseBaselineStore('{"default":"没有这份","baselines":[]}')).toEqual({ version: 1, baselines: [] })
  })

  it('选用顺序：文稿自己选的 → 默认 → 内置；检查结果注明用的哪份', () => {
    const mine = baselineFromSources('我', [{ name: 'a.txt', text: MINE.repeat(20) }])
    const other = baselineFromSources('别人', [{ name: 'b.txt', text: '雨停了，我去烧水。'.repeat(50) }])
    const store = upsertBaseline(upsertBaseline({ version: 1, baselines: [] }, mine, true), other)
    setBaselineStore(store)
    const { project: d } = projectFromText('这里的冬天不是冷，而是湿。墙角长出一层白霜，被子怎么晒都是潮的。', '稿')
    expect(resolveBaseline(d)?.name).toBe('我')
    const withMine = analyzeProject(d)
    expect(withMine.baseline).toBe('我')
    d.meta.flavor = { baseline: '内置' }
    expect(resolveBaseline(d)).toBeNull()
    const builtin = analyzeProject(d)
    expect(builtin.baseline).toBe('内置')
    // 作者自己常写"不是…而是…"：用他的基线，这一段的 AI 味更轻
    expect(withMine.index!).toBeLessThan(builtin.index!)
    d.meta.flavor = { baseline: '别人' }
    expect(analyzeProject(d).baseline).toBe('别人')
  })
})

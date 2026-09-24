import { describe, expect, it } from 'vitest'
import { analyzeDocument, analyzeText, buildBaseline, dialogueSpans, flavorDelta, guessGenre } from '.'

const rules = (text: string, genre: 'fiction' | 'essay' | 'general' = 'fiction') =>
  analyzeText(text, { genre }).hits.map((h) => h.rule)

describe('AI 味规则', () => {
  it('否定-修正句式：各种变体都能抓到', () => {
    expect(rules('市民们走路时总仰着头，不是在看天，是在查今天有没有人偷偷下了雨。')).toContain('neg_correction')
    expect(rules('这不是工具，而是一种思维方式。', 'essay')).toContain('neg_correction')
    expect(rules('他停下来。不是累了。是不想再走。')).toContain('neg_correction')
    expect(rules('那不是风——是有人在敲窗。')).toContain('neg_correction')
    expect(rules('这并非偶然，而是必然。', 'essay')).toContain('neg_correction')
  })

  it('否定-修正：正常用法不算', () => {
    for (const t of ['你是不是又熬夜了？', '要不是你提醒，我就忘了。', '这道题不是很难，是吧。', '我不是不想去。', '不是吗？是你自己说的。']) {
      expect(rules(t), t).not.toContain('neg_correction')
    }
  })

  it('对白里的句式不查，旁白里的才查', () => {
    const text = '“我不是生气，是担心你。”她说完就转身走了，门在身后关上。'
    expect(rules(text)).not.toContain('neg_correction')
    expect(dialogueSpans(text)).toEqual([[0, 13]])
  })

  it('破折号、升华、宏大开头、论文腔、黑话', () => {
    const essay = '随着人工智能的飞速发展，写作工具不仅仅是效率工具，更是思维的延伸。值得注意的是，它正在为内容行业赋能——这或许就是技术的意义。'
    const found = rules(essay, 'essay')
    for (const r of ['grand_opening', 'sublimation', 'paper_transition', 'jargon', 'em_dash', 'uplift_ending']) expect(found, r).toContain(r)
  })

  it('没有套路的段落：清爽', () => {
    const text = '雨停的时候已经过了十二点。我把伞挂回门后，鞋底的泥在地板上印出两排脚印，懒得擦，先去烧水。水壶响了三次我才起身。'
    const r = analyzeText(text, { genre: 'fiction' })
    expect(r.hits).toEqual([])
    expect(r.index).toBe(0)
    expect(r.level).toBe('清爽')
  })

  it('一段里的一个"不是…而是"就很显眼；整篇里偶尔一次不扣分', () => {
    const one = analyzeText('市民们习惯了仰着头走路，不是为了看天，而是为了确认今天有没有谁偷偷下了雨。', { genre: 'fiction' })
    expect(one.index).toBeGreaterThanOrEqual(35)
    const filler = '街上的人照常上班，报亭照常开门，卖早点的摊子冒着白气，公交车一辆接一辆地进站。'.repeat(80) // 约三千字
    const doc = analyzeDocument([
      { id: 'a', type: 'paragraph', text: filler },
      { id: 'b', type: 'paragraph', text: '他握住那只手。不是握，是抓。' },
    ], { genre: 'fiction' })
    expect(doc.rules.find((r) => r.rule === 'neg_correction')?.penalty).toBe(0)
    expect(doc.hits.some((h) => h.rule === 'neg_correction')).toBe(true) // 仍然标出位置，由作者定
  })

  it('高频虚词：密了才列出，每段只标一处', () => {
    const sparse = analyzeText('她微微点头，把杯子放回桌上。窗外有人在搬家，纸箱一个一个摞上货车。', { genre: 'fiction' })
    expect(sparse.hits.filter((h) => h.rule === 'soft_words')).toEqual([])
    const dense = analyzeText('她微微点头，轻轻放下杯子，缓缓起身，静静地望着窗外，仿佛在等谁。', { genre: 'fiction' })
    expect(dense.hits.filter((h) => h.rule === 'soft_words')).toHaveLength(1)
    expect(dense.rules.find((r) => r.rule === 'soft_words')?.count).toBe(5)
  })

  it('文体：文章不查小说专用的叙述规则', () => {
    const counted = (genre: 'fiction' | 'essay') => analyzeText('我感到一阵失落。', { genre }).rules.map((r) => r.rule)
    expect(counted('fiction')).toContain('emotion_label')
    expect(counted('essay')).not.toContain('emotion_label')
    expect(guessGenre('“走吧。”他说。“去哪？”她问。“随便。”')).toBe('fiction')
    expect(guessGenre('写作工具的核心问题是信任：作者需要知道每一处改动来自哪里。')).toBe('essay')
  })

  it('个人基线：作者自己常用的句式有豁免额度', () => {
    const para = '这里的冬天不是冷，而是湿。墙角长出一层白霜，被子怎么晒都是潮的。'
    const builtin = analyzeText(para, { genre: 'fiction' })
    const mine = buildBaseline('我', ['风不是吹，而是推。雨不是下，而是砸。'.repeat(10)])
    expect(mine.counts.neg_correction).toBe(20)
    const withBase = analyzeText(para, { genre: 'fiction', baseline: mine })
    expect(withBase.index!).toBeLessThan(builtin.index!)
    expect(withBase.baseline).toBe('我')
    // 作者从来不用的句式，一出现就重罚
    const never = buildBaseline('从不', ['雨停了，我去烧水。'.repeat(50)])
    expect(analyzeText(para, { genre: 'fiction', baseline: never }).index!).toBeGreaterThanOrEqual(builtin.index!)
  })

  it('句模复用：同一骨架在全文反复出现', () => {
    const blocks = ['当他推开门时，屋里没有人。', '当她抬起头时，天已经黑了。', '当雨落下来时，街上只剩路灯。', '他把钥匙放进口袋。']
      .map((text, i) => ({ id: `b${i}`, type: 'paragraph' as const, text }))
    const doc = analyzeDocument(blocks, { genre: 'fiction' })
    const f = doc.findings.find((x) => x.id === 'template_reuse')
    expect(f?.detail).toContain('当…时')
    expect(f?.hits).toHaveLength(3)
    expect(doc.blocks.find((b) => b.block === 'b0')?.hits.some((h) => h.rule === 'template_reuse')).toBe(true)
  })

  it('整篇检查跳过标题、图片与代码块，命中带段落 id', () => {
    const doc = analyzeDocument([
      { id: 'h', type: 'heading', text: '不是标题，而是测试' },
      { id: 'i', type: 'paragraph', text: '![不是图，而是图注](a.assets/x.png)' },
      { id: 'p', type: 'paragraph', text: '值得注意的是，这里有一处。' },
    ], { genre: 'essay' })
    expect(doc.hits.map((h) => [h.block, h.rule])).toEqual([['p', 'paper_transition']])
  })

  it('忽略：规则与具体命中', () => {
    const t = '值得注意的是，这里有一处。'
    expect(analyzeText(t, { genre: 'essay', ignoreRules: ['paper_transition'] }).hits).toEqual([])
    expect(analyzeText(t, { genre: 'essay', ignoreHits: ['paper_transition:值得注意的是'] }).hits).toEqual([])
  })

  it('改写前后对比：找出改写带进来的新套路', () => {
    const before = '市民们习惯了仰着头走路，不是为了看天，而是为了确认今天有没有谁偷偷下了雨。'
    const worse = '市民们走路时总仰着头——不是在看天，是在查今天有没有人偷偷下了雨。'
    const better = '市民们走路总仰着头，查今天有没有人偷偷下了雨。'
    const d1 = flavorDelta(before, worse, { genre: 'fiction' })
    expect(d1.added.map((h) => h.rule)).toEqual(['em_dash'])
    // 换了说法（"不是为了看天，而是" → "不是在看天，是"），仍是同一个套路：不算消掉
    expect(d1.kept.map((h) => [h.rule, h.text])).toEqual([['neg_correction', '不是在看天，是']])
    expect(d1.removed).toEqual([])
    const d2 = flavorDelta(before, better, { genre: 'fiction' })
    expect(d2.added).toEqual([])
    expect(d2.removed.map((h) => h.rule)).toContain('neg_correction')
    expect(d2.after!).toBeLessThan(d2.before!)
  })
})

describe('AI 味规则：校准', () => {
  it('顿号列举：专名列表不算；轻级规则单独最多到"轻微"', () => {
    expect(rules('导出 HTML、Markdown、PDF，内置 DeepSeek、Kimi、OpenAI。', 'essay')).not.toContain('dense_enum')
    const listy = '他买了苹果、香蕉、橘子，又挑了毛巾、牙刷、拖鞋，还看了锅碗、瓢盆、筷子。'.repeat(3)
    const r = analyzeText(listy, { genre: 'essay' })
    expect(r.rules.find((x) => x.rule === 'dense_enum')?.penalty).toBeGreaterThan(0)
    expect(r.level === '清爽' || r.level === '轻微').toBe(true)
  })
})

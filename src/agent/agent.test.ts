import { describe, expect, it } from 'vitest'
import { produce } from 'immer'
import type { ProjectData } from '../types'
import { applySuggestion } from '../lib/doc'
import { exportMarkdown, projectFromText } from '../lib/project'
import { runOps, type OpCall } from './run'
import { describeOps } from './ops'
import { cancelTask, createTask } from '../lib/tasks'

const MD = `# 城市

## 引言

在这座城市里，雨是一种被审计的液体。每一滴水的下落都要经过市政厅的批准。

## 经济

城里流通两种货币。水票不记名。

## 尾声

市政厅至今没有给出解释。
`

const doc = () => projectFromText(MD).project
const granted = () => produce(doc(), (d) => void (d.meta.agentAccess = 'direct'))
const as = { author: 'Claude Code' }

function ok(data: ProjectData, calls: OpCall[], direct = false) {
  const r = runOps(data, calls, { ...as, direct })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r
}

function fail(data: ProjectData, calls: OpCall[], direct = false) {
  const r = runOps(data, calls, { ...as, direct })
  if (r.ok) throw new Error('应当失败')
  return r
}

describe('读', () => {
  it('outline 给出标题 id、段落数与字数', () => {
    const r = ok(doc(), [{ op: 'outline' }])
    const outline = r.results[0] as { headings: { title: string; paragraphs: number }[] }
    expect(outline.headings.map((h) => [h.title, h.paragraphs])).toEqual([
      ['引言', 1],
      ['经济', 1],
      ['尾声', 1],
    ])
  })

  it('read 可以按章节读，并分页', () => {
    const r = ok(doc(), [{ op: 'read', section: '经济' }, { op: 'read', limit: 2 }])
    const [section, page] = r.results as { blocks: { text: string }[]; next?: string }[]
    expect(section.blocks.map((b) => b.text)).toEqual(['经济', '城里流通两种货币。水票不记名。'])
    expect(page.blocks).toHaveLength(2)
    expect(page.next).toBeTruthy()
  })

  it('find 返回段落 id 与上下文；出现多次时给出序号', () => {
    const r = ok(doc(), [{ op: 'find', text: '市政厅' }])
    const found = r.results[0] as { count: number; matches: { occurrence: number; section: string }[] }
    expect(found.count).toBe(2)
    expect(found.matches.map((m) => m.section)).toEqual(['引言', '尾声'])
  })

  it('读操作不改文稿', () => {
    const d = doc()
    expect(ok(d, [{ op: 'info' }, { op: 'outline' }]).data).toBe(d)
  })
})

describe('提建议（默认）', () => {
  it('按引文替换：只产生署名建议，正文不变；作者接受后才写入', () => {
    const d = doc()
    const r = ok(d, [{ op: 'replace', target: { quote: '被审计的液体' }, text: '需要登记的液体', why: '更具体' }])
    expect(exportMarkdown(r.data)).toBe(exportMarkdown(d))
    const s = r.data.suggestions[0]
    expect(s).toMatchObject({
      kind: 'ai_diff',
      state: 'pending',
      author: { kind: 'agent', name: 'Claude Code' },
      why: '更具体',
      changeset: r.changeset,
      original: '被审计的液体',
    })
    const after = produce(r.data, (x) => void applySuggestion(x, s.id, s.proposed))
    expect(exportMarkdown(after)).toContain('雨是一种需要登记的液体。')
    const block = after.blocks.find((b) => b.text.includes('需要登记'))!
    expect(block.versions.at(-1)).toMatchObject({ source: 'agent', author: 'Claude Code', instruction: '更具体' })
  })

  it('引文出现多次：报 AMBIGUOUS 并列出候选；给 occurrence 即可', () => {
    const r = fail(doc(), [{ op: 'replace', target: { quote: '市政厅' }, text: '议会' }])
    expect(r.error.code).toBe('AMBIGUOUS')
    expect(r.error.candidates).toHaveLength(2)
    ok(doc(), [{ op: 'replace', target: { quote: '市政厅', occurrence: 2 }, text: '议会' }])
  })

  it('引文找不到：报 NOT_FOUND 并提示先 find', () => {
    const r = fail(doc(), [{ op: 'replace', target: { quote: '不存在的话' }, text: 'x' }])
    expect(r.error.code).toBe('NOT_FOUND')
    expect(r.error.hint).toContain('find')
  })

  it('同一段的两处修改合成一条建议', () => {
    const r = ok(doc(), [
      { op: 'replace', target: { quote: '两种货币' }, text: '两套货币' },
      { op: 'replace', target: { quote: '不记名' }, text: '不署名' },
    ])
    const pending = r.data.suggestions.filter((s) => s.state === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0].proposed).toBe('城里流通两套货币。水票不署名。')
  })

  it('一批里任何一步失败，整批都不生效', () => {
    const d = doc()
    const r = fail(d, [
      { op: 'replace', target: { quote: '两种货币' }, text: '两套货币' },
      { op: 'replace', target: { quote: '货币。水' }, text: 'x' },
    ])
    expect(r.error.code).toBe('CONFLICT')
    expect(r.index).toBe(1)
    expect(d.suggestions).toHaveLength(0)
  })

  it('插入可以带小标题：接受后成为真正的标题', () => {
    const r = ok(doc(), [{ op: 'insert', after: { section: '经济' }, text: '### 黑市\n\n水票溢价三成。' }])
    const s = r.data.suggestions[0]
    const after = produce(r.data, (x) => void applySuggestion(x, s.id, s.proposed))
    expect(exportMarkdown(after)).toContain('## 经济\n\n城里流通两种货币。水票不记名。\n\n### 黑市\n\n水票溢价三成。\n\n## 尾声')
  })

  it('note 只留意见；withdraw 只能撤回自己的', () => {
    const r = ok(doc(), [{ op: 'note', target: { section: '尾声' }, issue: '收尾太仓促', advice: '补一个细节' }])
    const id = r.data.suggestions[0].id
    expect(runOps(r.data, [{ op: 'withdraw', suggestion: id }], { author: '别人' }).ok).toBe(false)
    const back = ok(r.data, [{ op: 'withdraw', suggestion: id }])
    expect(back.data.suggestions[0].state).toBe('rejected')
  })

  it('结构修改在提建议模式下被拒绝', () => {
    const r = fail(doc(), [{ op: 'rename_heading', heading: '尾声', text: '后记' }])
    expect(r.error.code).toBe('NOT_AUTHORIZED')
  })

  it('参数不对给出可读的错误', () => {
    expect(fail(doc(), [{ op: 'replace', target: { quote: 'x' } }]).error.message).toContain('text')
    expect(fail(doc(), [{ op: 'nope' }]).error.code).toBe('UNKNOWN_OP')
    expect(fail(doc(), [{ op: 'replace', target: { quote: '雨', block: 'b' }, text: 'x' }]).error.message).toContain('只能给一种')
  })
})

describe('直接修改（需作者授权）', () => {
  it('没授权时 --direct 整批被拒', () => {
    expect(fail(doc(), [{ op: 'info' }], true).error.code).toBe('NOT_AUTHORIZED')
  })

  it('授权后直接写入，版本记下 agent 署名', () => {
    const r = ok(
      granted(),
      [
        { op: 'replace', target: { quote: '两种货币' }, text: '两套货币', why: '用词' },
        { op: 'rename_heading', heading: '尾声', text: '后记' },
        { op: 'move_section', heading: '后记', to: '引言', position: 'before' },
      ],
      true
    )
    const md = exportMarkdown(r.data)
    expect(md).toContain('城里流通两套货币。')
    expect(md.indexOf('## 后记')).toBeLessThan(md.indexOf('## 引言'))
    const block = r.data.blocks.find((b) => b.text.startsWith('城里'))!
    expect(block.versions.at(-1)).toMatchObject({ source: 'agent', author: 'Claude Code' })
  })

  it('授权了但没请求 direct：仍然只提建议', () => {
    const r = ok(granted(), [{ op: 'replace', target: { quote: '两种货币' }, text: '两套货币' }])
    expect(r.mode).toBe('propose')
    expect(r.data.suggestions[0].state).toBe('pending')
  })
})

describe('describeOps', () => {
  it('每个操作都有说明与参数 schema', () => {
    for (const op of describeOps()) {
      expect(op.summary.length).toBeGreaterThan(4)
      expect(op.params.type).toBe('object')
    }
  })
})

describe('结果', () => {
  it('读操作的结果在执行后仍可读取、可序列化（不引用已失效的草稿）', () => {
    const d = ok(doc(), [{ op: 'replace', target: { quote: '被审计' }, text: '要登记' }]).data
    const r = ok(d, [{ op: 'suggestions' }, { op: 'read' }])
    const text = JSON.stringify(r.results)
    expect(text).toContain('"blockIds"')
    expect((r.results[0] as { suggestions: { target: { blockIds: string[] } }[] }).suggestions[0].target.blockIds).toHaveLength(1)
  })
})

describe('交给 Agent 的任务', () => {
  const withTask = () => {
    const d = doc()
    const p = d.blocks.find((b) => b.type === 'paragraph')!
    return produce(d, (x) => void createTask(x, { instruction: '更口语', target: { blockIds: [p.id] }, quote: p.text, section: '引言' }))
  }

  it('tasks 列出还没做完的任务；原文变过时标出 changed', () => {
    const d = withTask()
    const r = ok(d, [{ op: 'tasks' }])
    expect(r.results[0]).toMatchObject({ tasks: [{ state: 'open', instruction: '更口语', section: '引言' }] })
    expect((r.results[0] as { tasks: { changed?: boolean }[] }).tasks[0].changed).toBeUndefined()
    const p = d.blocks.find((b) => b.type === 'paragraph')!
    const edited = produce(d, (x) => void (x.blocks.find((b) => b.id === p.id)!.text = '改过了。'))
    expect((ok(edited, [{ op: 'tasks' }]).results[0] as { tasks: { changed?: boolean }[] }).tasks[0].changed).toBe(true)
    expect(ok(d, [{ op: 'info' }]).results[0]).toMatchObject({ tasks: 1 })
  })

  it('接手 → 完成；提建议模式下即可操作，不需要授权', () => {
    const d = withTask()
    const id = d.tasks![0].id
    const claimed = ok(d, [{ op: 'claim_task', task: id }])
    expect(claimed.data.tasks![0]).toMatchObject({ state: 'claimed', claimedBy: 'Claude Code' })
    const done = ok(claimed.data, [{ op: 'complete_task', task: id, summary: '提了 2 处修改' }])
    expect(done.data.tasks![0]).toMatchObject({ state: 'done', summary: '提了 2 处修改' })
    expect((ok(done.data, [{ op: 'tasks' }]).results[0] as { tasks: unknown[] }).tasks).toHaveLength(0)
    expect((ok(done.data, [{ op: 'tasks', state: 'all' }]).results[0] as { tasks: unknown[] }).tasks).toHaveLength(1)
  })

  it('别人接手了的不能抢；作者取消的不能再做；不存在的报 NOT_FOUND', () => {
    const d = withTask()
    const id = d.tasks![0].id
    const other = runOps(d, [{ op: 'claim_task', task: id }], { author: 'Codex' })
    if (!other.ok) throw new Error('op failed')
    expect(fail(other.data, [{ op: 'complete_task', task: id }]).error.code).toBe('CONFLICT')
    const cancelled = produce(d, (x) => void cancelTask(x, id))
    expect(fail(cancelled, [{ op: 'claim_task', task: id }]).error.code).toBe('INVALID_PARAMS')
    expect(fail(d, [{ op: 'claim_task', task: 't_none' }]).error.code).toBe('NOT_FOUND')
  })
})

describe('delete：空段落也能删掉', () => {
  it('直接修改时删除整段空段落', () => {
    const { project: d } = projectFromText('第一段。\n\n第二段。', '稿')
    d.blocks.splice(1, 0, { id: 'b_empty', type: 'paragraph', text: '', versions: [] })
    d.meta.agentAccess = 'direct'
    const r = runOps(d, [{ op: 'delete', target: { block: 'b_empty' } }], { author: 'Codex', direct: true })
    expect(r.ok && r.data.blocks.map((b) => b.text)).toEqual(['第一段。', '第二段。'])
  })
})

import { describe, expect, it } from 'vitest'
import { projectFromText } from '../project'
import { runOps } from '../../agent/run'

const doc = () =>
  projectFromText(
    '# 城市\n\n## 引言\n\n市民们习惯了仰着头走路，不是为了看天，而是为了确认今天有没有谁偷偷下了雨。\n\n## 尾声\n\n雨停的时候已经过了十二点，我把伞挂回门后，鞋底的泥在地板上印出两排脚印。\n',
    '城市'
  ).project

import type { OpCall } from '../../agent/run'
import type { ProjectData } from '../../types'

const run = (d: ProjectData, calls: OpCall[]): unknown[] => {
  const r = runOps(d, calls, { author: 'Codex' })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.results
}

describe('agent 操作 flavor', () => {
  it('整篇与某一节：指数、命中（可直接定位）、改法', () => {
    const d = doc()
    const v = run(d, [{ op: 'flavor' }])[0] as { index: number; hits: { quote: string; rule: string; section: string }[]; advice: Record<string, string> }
    expect(v.hits).toEqual([expect.objectContaining({ rule: 'neg_correction', quote: '不是为了看天，而是', section: '引言' })])
    expect(v.advice.neg_correction).toBeTruthy()
    expect(v.index).toBeGreaterThan(0)
    const tail = run(d, [{ op: 'flavor', section: '尾声' }])[0] as { hits: unknown[]; index: number }
    expect(tail.hits).toEqual([])
    expect(tail.index).toBe(0)
  })

  it('检查一段尚未提交的文字', () => {
    const v = run(doc(), [{ op: 'flavor', text: '他停下来——不是累了，是不想再走。' }])[0] as { hits: { rule: string }[] }
    expect(v.hits.map((h) => h.rule).sort()).toEqual(['em_dash', 'neg_correction'])
  })

  it('修改带进了新套路：返回结果里提醒 agent；改得干净就不提', () => {
    const d = doc()
    const w = run(d, [{ op: 'replace', target: { quote: '雨停的时候已经过了十二点' }, text: '雨停了——不是停了，是累了' }])[0] as { flavor?: { added: { rule: string }[]; hint: string } }
    expect(w.flavor?.added.map((h) => h.rule)).toEqual(expect.arrayContaining(['em_dash', 'neg_correction']))
    expect(w.flavor?.hint).toContain('withdraw')
    const clean = run(doc(), [{ op: 'replace', target: { quote: '不是为了看天，而是为了确认' }, text: '是在查' }])[0]
    expect((clean as { flavor?: unknown }).flavor).toBeUndefined()
  })

  it('作者忽略过的命中不再报', () => {
    const d = doc()
    d.meta.flavor = { ignore: ['neg_correction:不是为了看天，而是'] }
    const v = run(d, [{ op: 'flavor' }])[0] as { hits: unknown[] }
    expect(v.hits).toEqual([])
  })
})

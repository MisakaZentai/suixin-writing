import { describe, expect, it } from 'vitest'
import { projectFromText } from '../project'
import { addLabel, labelsOfDoc, makeLabel, parseLabelStore, removeLabel, serializeLabelStore } from './labels'
import type { ParagraphBlock } from '../../types'

const doc = () =>
  projectFromText('活倒是干得没毛病，就是慢。我愣了一下。\n\n雨停的时候已经过了十二点，我把伞挂回门后。', '稿').project
const para = (d: ReturnType<typeof doc>, i: number) => d.blocks.filter((b) => b.type === 'paragraph')[i] as ParagraphBlock

describe('作者标注', () => {
  it('记下原文、引擎当时的判断与这段是谁写的', () => {
    const d = doc()
    const hit = makeLabel(d, para(d, 0), { id: 'd1', path: null })
    expect(hit).toMatchObject({ verdict: 'ai', docId: 'd1', docTitle: '稿', origin: 'import', aiTouched: false })
    expect(hit.hits).toEqual(expect.arrayContaining(['concession_balance', 'reaction_beat'])) // 留出的规则也记下
    const missed = makeLabel(d, para(d, 1), { id: 'd1', path: null })
    expect(missed.hits).toEqual([])
    // 划选的一句：只按这一句查
    const quote = makeLabel(d, para(d, 0), { id: 'd1' }, '我愣了一下。')
    expect(quote.quote).toBe('我愣了一下。')
    expect(quote.hits).toEqual(['reaction_beat'])
  })

  it('AI 改过的段落标出来；存取、按文稿筛选、删除', () => {
    const d = doc()
    const b = para(d, 1)
    b.versions.push({ v: 2, text: b.text, source: 'agent', instruction: null, at: '', author: 'Codex' })
    const l = makeLabel(d, b, { id: 'd1' })
    expect(l).toMatchObject({ origin: 'agent', originAuthor: 'Codex', aiTouched: true })
    let store = addLabel({ version: 1, labels: [] }, l)
    store = addLabel(store, { ...l, id: 'other', docId: 'd2' })
    store = parseLabelStore(serializeLabelStore(store))
    expect(labelsOfDoc(store, { id: 'd1', title: '稿' }).map((x) => x.id)).toEqual([l.id])
    expect(removeLabel(store, l.id).labels.map((x) => x.id)).toEqual(['other'])
    expect(parseLabelStore('坏的')).toEqual({ version: 1, labels: [] })
  })
})

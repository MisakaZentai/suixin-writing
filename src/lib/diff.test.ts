import { describe, expect, it } from 'vitest'
import { applyDecisions, changeRatio, clusterize, computeDiff } from './diff'

const OLD = '在这座城市里，雨是一种被审计的液体。每一滴水的下落都要经过市政厅的批准。'
const NEW = '在这座城市里，雨是一种要被审计的液体。每滴水落下前都得经市政厅批准。'

describe('computeDiff', () => {
  it('全部接受得到新文本，全部拒绝得到原文', () => {
    const ops = computeDiff(OLD, NEW)
    const n = clusterize(ops).length
    expect(applyDecisions(ops, new Array(n).fill(true))).toBe(NEW)
    expect(applyDecisions(ops, new Array(n).fill(false))).toBe(OLD)
  })

  it('按词对齐：不会把一个词拆成半个字的红绿碎片', () => {
    const ops = computeDiff('他们在市政厅开会。', '他们在图书馆开会。')
    const changed = ops.filter((o) => o.op !== 'keep').map((o) => o.text)
    expect(changed).toEqual(['市政厅', '图书馆'])
  })

  it('相同文本没有改动', () => {
    expect(computeDiff('一样', '一样')).toEqual([{ op: 'keep', text: '一样' }])
  })

  it('纯新增（续写）只有一处', () => {
    const ops = computeDiff('', '新写的内容。')
    expect(ops).toEqual([{ op: 'ins', text: '新写的内容。' }])
    expect(clusterize(ops)).toHaveLength(1)
  })
})

describe('clusterize', () => {
  it('同一分句里挨得很近的改动合成一处，跨句的分开', () => {
    const ops = computeDiff(OLD, NEW)
    const clusters = clusterize(ops)
    // 第一句一处（"要"），第二句一处（整句改写）
    expect(clusters).toHaveLength(2)
  })

  it('逐处裁决：只接受第一处', () => {
    const ops = computeDiff(OLD, NEW)
    const result = applyDecisions(ops, [true, false])
    expect(result).toBe('在这座城市里，雨是一种要被审计的液体。每一滴水的下落都要经过市政厅的批准。')
  })
})

describe('changeRatio', () => {
  it('小改动比例低，整段重写比例高', () => {
    expect(changeRatio(computeDiff('今天天气很好。', '今天天气真好。'))).toBeLessThan(0.3)
    expect(changeRatio(computeDiff('今天天气很好。', '阳光灿烂，适合出门走走。'))).toBeGreaterThan(0.5)
  })
})

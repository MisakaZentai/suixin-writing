import { describe, expect, it } from 'vitest'
import { produce } from 'immer'
import { runOps } from '../agent/run'
import { editBlock } from './doc'
import { projectFromText } from './project'
import { reconcile } from './sync'
import { cancelTask, claimTask, completeTask, createTask } from './tasks'

const base = () => projectFromText('# 稿\n\n## 一\n\n第一段。\n\n第二段。\n').project

describe('reconcile：绑定文件被外部改动', () => {
  it('agent 只提了建议：即使本地有没保存的改动，也只是把建议并进来', () => {
    const b = base()
    const r = runOps(b, [{ op: 'replace', target: { quote: '第二段' }, text: '次段' }], { author: 'Codex' })
    if (!r.ok) throw new Error('op failed')
    const local = produce(b, (d) => void editBlock(d, d.blocks[1].id, '第一段，改过。'))
    const out = reconcile(b, local, r.data, true)
    expect(out.action).toBe('merge')
    expect(out.data.blocks[1].text).toBe('第一段，改过。')
    expect(out.data.suggestions).toHaveLength(1)
    expect(out.summary).toBe('Codex 提了 1 条建议')
  })

  it('外部改了正文、本地没有未保存改动：直接载入', () => {
    const b = base()
    const ext = produce(b, (d) => void editBlock(d, d.blocks[1].id, '外部改的。'))
    const out = reconcile(b, b, ext, false)
    expect(out.action).toBe('replace')
    expect(out.data.blocks[1].text).toBe('外部改的。')
  })

  it('双方都改了正文：冲突，交给作者选择', () => {
    const b = base()
    const ext = produce(b, (d) => void editBlock(d, d.blocks[1].id, '外部改的。'))
    const local = produce(b, (d) => void editBlock(d, d.blocks[2].id, '本地改的。'))
    expect(reconcile(b, local, ext, true).action).toBe('conflict')
  })

  it('外部程序不能自己给自己授权直接修改', () => {
    const b = base()
    const ext = produce(b, (d) => {
      d.meta.agentAccess = 'direct'
      editBlock(d, d.blocks[1].id, '外部改的。')
    })
    expect(reconcile(b, b, ext, false).data.meta.agentAccess).toBeUndefined()
    const onlyAccess = produce(b, (d) => void (d.meta.agentAccess = 'direct'))
    expect(reconcile(b, b, onlyAccess, false).data.meta.agentAccess).toBeUndefined()
  })
})

describe('reconcile：任务', () => {
  it('agent 经文件接手 / 完成任务：并进来并写进摘要；作者这边取消的以这边为准', () => {
    const b = produce(base(), (d) => {
      createTask(d, { instruction: '甲', target: { blockIds: [d.blocks[1].id] }, quote: '第一段。' })
      createTask(d, { instruction: '乙', target: { blockIds: [d.blocks[2].id] }, quote: '第二段。' })
    })
    const [t1, t2] = b.tasks!.map((t) => t.id)
    const ext = produce(b, (d) => {
      completeTask(d, t1, 'Codex', '改好了')
      claimTask(d, t2, 'Codex')
    })
    const local = produce(b, (d) => void cancelTask(d, t2))
    const out = reconcile(b, local, ext, false)
    expect(out.action).toBe('merge')
    expect(out.data.tasks!.map((t) => t.state)).toEqual(['done', 'cancelled'])
    expect(out.summary).toContain('Codex 完成了任务')
  })

  it('作者刚交办、文件里还没有的任务不会丢', () => {
    const b = base()
    const local = produce(b, (d) => void createTask(d, { instruction: '甲', target: { blockIds: [] }, quote: '' }))
    const ext = produce(b, (d) => void (d.suggestions = []))
    const r = runOps(b, [{ op: 'replace', target: { quote: '第二段' }, text: '次段' }], { author: 'Codex' })
    if (!r.ok) throw new Error('op failed')
    expect(reconcile(b, local, r.data, true).data.tasks).toHaveLength(1)
    expect(reconcile(b, local, ext, true).data.tasks).toHaveLength(1)
  })
})

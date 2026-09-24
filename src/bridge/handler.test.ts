import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectData } from '../types'
import type { BridgeEvent } from './protocol'

// store 里用到 window.setTimeout；节点环境下借用全局对象
beforeAll(() => {
  ;(globalThis as unknown as { window: typeof globalThis }).window = globalThis
})

const { projectFromText } = await import('../lib/project')
const { useProjectStore } = await import('../store/projectStore')
const { useDocsStore } = await import('../store/docsStore')
const { useUIStore } = await import('../store/uiStore')
const { useBridgeStore } = await import('../store/bridgeStore')
const { handleBridgeRequest, samePath, selectionView } = await import('./handler')
const { startEventPublishing } = await import('./events')

const PATH = 'C:\\稿\\城市.suixin.json'
const project = () => useProjectStore.getState()
const data = () => project().data as ProjectData
const paragraphs = () => data().blocks.filter((b) => b.type === 'paragraph')

function open(md = '# 城市\n\n## 引言\n\n雨是一种被审计的液体。\n\n市政厅没有解释。\n', id = 'd1', path: string | null = PATH) {
  useProjectStore.getState().setDocument(projectFromText(md).project)
  useDocsStore.setState({ current: { id, path }, external: null, status: 'saved' })
  useUIStore.setState({ activeId: null, selection: null, textRange: null, editing: null, toasts: [] })
  useBridgeStore.setState({ accessRequests: [] })
}

const call = (method: string, params: Record<string, unknown> = {}, agent = 'Codex') =>
  handleBridgeRequest({ method, params, agent })

beforeEach(() => open())

describe('实时桥：在 App 的文稿上执行 agent 操作', () => {
  it('提建议：立即进入 App 里的文稿，署名，并提示作者', async () => {
    const r = await call('doc.operate', { file: '@', calls: [{ op: 'replace', target: { quote: '被审计' }, text: '要登记', why: '口语' }] })
    expect(r).toMatchObject({ ok: true, result: { handled: true, via: 'app', mode: 'propose', written: true, file: PATH } })
    expect(data().suggestions).toHaveLength(1)
    expect(data().suggestions[0]).toMatchObject({ author: { name: 'Codex' }, why: '口语', state: 'pending' })
    expect(paragraphs()[0].text).toBe('雨是一种被审计的液体。')
    expect(useUIStore.getState().toasts.at(-1)?.text).toBe('Codex 提了 1 条建议')
    // 进了撤销历史
    project().undo()
    expect(data().suggestions).toHaveLength(0)
  })

  it('指定的文件不是 App 里打开的那篇：交还给命令行；路径写法不同也认得出', async () => {
    expect(await call('doc.operate', { file: 'D:\\别的.suixin.json', calls: [{ op: 'info' }] })).toEqual({ ok: true, result: { handled: false } })
    const r = await call('doc.operate', { file: 'c:/稿/城市.suixin.json', calls: [{ op: 'info' }] })
    expect(r).toMatchObject({ ok: true, result: { handled: true } })
    expect(samePath('/a/b.json', '/a/B.json')).toBe(false)
  })

  it('没有打开的文稿：@ 报 NOT_FOUND', async () => {
    useProjectStore.getState().setDocument(null)
    useDocsStore.setState({ current: null })
    const r = await call('doc.operate', { calls: [{ op: 'info' }] })
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('权限以 App 为准：未授权的 direct 被拒；授权后可直接改，但不动作者正在编辑的段落', async () => {
    const direct = (quote: string, text: string) =>
      call('doc.operate', { calls: [{ op: 'replace', target: { quote }, text }], direct: true })
    expect(await direct('被审计', '要登记')).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } })
    project().setAgentAccess('direct')
    const editing = paragraphs()[1].id
    useUIStore.setState({ editing: { id: editing, draft: '市政厅没有解释。', token: 1 } })
    expect(await direct('没有解释', '从不解释')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await direct('被审计', '要登记')).toMatchObject({ ok: true, result: { mode: 'direct', written: true } })
    expect(paragraphs()[0].text).toBe('雨是一种要登记的液体。')
    // 直接修改：提示作者，并能一键撤销
    const toast = useUIStore.getState().toasts.at(-1)!
    expect(toast).toMatchObject({ text: 'Codex 直接修改了这篇文稿', actionLabel: '撤销' })
    toast.onAction!()
    expect(paragraphs()[0].text).toBe('雨是一种被审计的液体。')
  })

  it('批量里一处失败：整批不生效，报出是第几个', async () => {
    const r = await call('doc.operate', {
      calls: [
        { op: 'replace', target: { quote: '被审计' }, text: '要登记' },
        { op: 'replace', target: { quote: '不存在的话' }, text: 'x' },
      ],
    })
    expect(r).toMatchObject({ ok: false, index: 1, error: { code: 'NOT_FOUND' } })
    expect(data().suggestions).toHaveLength(0)
  })

  it('处理外部修改冲突期间不接受操作', async () => {
    useDocsStore.setState({ external: { raw: '', data: data(), summary: '' } })
    expect(await call('doc.operate', { calls: [{ op: 'info' }] })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
  })
})

describe('在线授权', () => {
  it('作者允许：授权写进文稿；已授权时直接返回', async () => {
    const pending = call('access.request', { reason: '要调整章节顺序' })
    await Promise.resolve()
    const req = useBridgeStore.getState().accessRequests[0]
    expect(req).toMatchObject({ agent: 'Codex', reason: '要调整章节顺序', title: '城市' })
    useBridgeStore.getState().answerAccess(req.id, true)
    expect(await pending).toEqual({ ok: true, result: { granted: true } })
    expect(data().meta.agentAccess).toBe('direct')
    expect(await call('access.request')).toEqual({ ok: true, result: { granted: true, already: true } })
  })

  it('作者拒绝，或回应前切走了文稿：不授权；同一 agent 的重复请求只弹一次', async () => {
    const a = call('access.request')
    const b = call('access.request')
    await Promise.resolve()
    expect(useBridgeStore.getState().accessRequests).toHaveLength(1)
    useBridgeStore.getState().answerAccess(useBridgeStore.getState().accessRequests[0].id, false)
    expect(await a).toEqual({ ok: true, result: { granted: false } })
    expect(await b).toEqual({ ok: true, result: { granted: false } })

    const c = call('access.request')
    await Promise.resolve()
    const id = useBridgeStore.getState().accessRequests[0].id
    // 作者还没回应就打开了另一篇
    useProjectStore.getState().setDocument(projectFromText('# 另一篇\n\n正文。').project)
    useDocsStore.setState({ current: { id: 'd2', path: null } })
    useBridgeStore.getState().answerAccess(id, true)
    expect(await c).toEqual({ ok: true, result: { granted: false } })
    expect(data().meta.agentAccess).toBeUndefined()
  })
})

describe('选区与状态', () => {
  it('段内划选给出 quote + in；选中一段给出 block；标题给出整节', () => {
    const p = paragraphs()[0]
    useUIStore.setState({ textRange: { blockId: p.id, start: 4, end: 7, rect: { top: 0, left: 0, width: 0, bottom: 0 } } })
    expect(selectionView()).toMatchObject({ kind: 'range', text: '被审计', target: { quote: '被审计', in: p.id }, section: '引言' })
    useUIStore.setState({ textRange: null, activeId: p.id })
    expect(selectionView()).toMatchObject({ kind: 'paragraphs', target: { block: p.id } })
    const h = data().blocks.find((b) => b.type === 'heading')!
    useUIStore.setState({ activeId: h.id })
    expect(selectionView()).toMatchObject({ kind: 'section', target: { section: h.id }, section: '引言' })
  })

  it('app.status 报告文稿、权限、待办与选区', async () => {
    const r = await call('app.status')
    expect(r).toMatchObject({ ok: true, result: { document: { id: 'd1', title: '城市', path: PATH }, access: 'propose', pending: 0, tasks: 0, selection: null } })
  })
})

describe('事件', () => {
  it('作者处理建议、交办 / 取消任务、改授权、切换文稿都会发出事件', async () => {
    const events: BridgeEvent[] = []
    const stop = startEventPublishing((e) => events.push(e))
    try {
      await call('doc.operate', { calls: [{ op: 'replace', target: { quote: '被审计' }, text: '要登记' }] })
      const sg = data().suggestions[0]
      project().applySuggestion(sg.id, sg.proposed)
      const task = project().addTask({ instruction: '更口语', target: { blockIds: [paragraphs()[1].id] }, quote: '市政厅没有解释。' })!
      project().cancelTask(task)
      project().setAgentAccess('direct')
      useDocsStore.setState({ current: { id: 'd9', path: null } })
      expect(events.map((e) => e.type)).toEqual([
        'suggestion.resolved',
        'task.created',
        'task.cancelled',
        'access.changed',
        'document.opened',
      ])
      // 段内片段的建议：text 是被接受的那段新文字
      expect(events[0]).toMatchObject({ suggestion: sg.id, author: 'Codex', state: 'accepted', text: '要登记' })
      expect(paragraphs()[0].text).toBe('雨是一种要登记的液体。')
      expect(events[1]).toMatchObject({ task: { id: task, instruction: '更口语' }, document: { id: 'd1' } })
    } finally {
      stop()
    }
  })

  it('切换文稿不会被误报成作者处理了建议', async () => {
    await call('doc.operate', { calls: [{ op: 'replace', target: { quote: '被审计' }, text: '要登记' }] })
    const events: BridgeEvent[] = []
    const stop = startEventPublishing((e) => events.push(e))
    try {
      open('# 别的\n\n正文。', 'd3')
      expect(events.filter((e) => e.type === 'suggestion.resolved')).toHaveLength(0)
    } finally {
      stop()
    }
  })
})

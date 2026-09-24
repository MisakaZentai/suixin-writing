/**
 * 把作者在 App 里的动作变成事件，交给等待中的 agent：
 * 接受 / 放弃 agent 的建议、交办或取消任务、改授权、切换文稿、改变选区。
 */
import type { AgentTask, ProjectData, Suggestion } from '../types'
import { nowISO } from '../lib/ids'
import { useProjectStore } from '../store/projectStore'
import { useDocsStore } from '../store/docsStore'
import { useUIStore } from '../store/uiStore'
import { docRef, selectionView } from './handler'
import type { BridgeEvent, BridgeEventType } from './protocol'

export type Publish = (event: BridgeEvent) => void

const SELECTION_DEBOUNCE = 400

function event(type: BridgeEventType, extra: Record<string, unknown> = {}): BridgeEvent {
  return { type, at: nowISO(), document: docRef(), ...extra }
}

function taskEventView(t: AgentTask) {
  return { id: t.id, instruction: t.instruction, quote: t.quote, section: t.section, target: t.target }
}

/** 作者处理了哪些 agent 的建议 */
function resolvedSuggestions(prev: ProjectData, next: ProjectData): Suggestion[] {
  const before = new Map(prev.suggestions.map((s) => [s.id, s.state]))
  return next.suggestions.filter((s) => s.author?.kind === 'agent' && s.state !== 'pending' && before.get(s.id) === 'pending')
}

export function startEventPublishing(publish: Publish): () => void {
  const offProject = useProjectStore.subscribe((s, prev) => {
    const next = s.data
    const old = prev.data
    // 切换文稿（setDocument）不算作者的动作
    if (!next || !old || next === old || next.meta.createdAt !== old.meta.createdAt) return
    for (const sg of resolvedSuggestions(old, next)) {
      publish(
        event('suggestion.resolved', {
          suggestion: sg.id,
          changeset: sg.changeset,
          author: sg.author?.name,
          state: sg.state,
          ...(sg.state === 'accepted' ? { text: sg.proposed } : {}),
        })
      )
    }
    const oldTasks = new Map((old.tasks ?? []).map((t) => [t.id, t.state]))
    for (const t of next.tasks ?? []) {
      const was = oldTasks.get(t.id)
      if (was === undefined && t.state === 'open') publish(event('task.created', { task: taskEventView(t) }))
      else if (was !== 'cancelled' && was !== undefined && t.state === 'cancelled') publish(event('task.cancelled', { task: t.id }))
    }
    if ((next.meta.agentAccess ?? 'propose') !== (old.meta.agentAccess ?? 'propose')) {
      publish(event('access.changed', { access: next.meta.agentAccess ?? 'propose' }))
    }
  })

  const offDocs = useDocsStore.subscribe((s, prev) => {
    if (s.current?.id === prev.current?.id) return
    publish(s.current ? event('document.opened') : { ...event('document.closed'), document: null })
  })

  let timer = 0
  let last = ''
  const offUI = useUIStore.subscribe((s, prev) => {
    if (s.activeId === prev.activeId && s.selection === prev.selection && s.textRange === prev.textRange) return
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      const selection = selectionView()
      const key = JSON.stringify(selection?.target ?? null)
      if (key === last) return
      last = key
      publish(event('selection.changed', { selection }))
    }, SELECTION_DEBOUNCE)
  })

  return () => {
    offProject()
    offDocs()
    offUI()
    window.clearTimeout(timer)
  }
}

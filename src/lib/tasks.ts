/**
 * "交给 Agent"的任务：纯函数，App 与 agent 操作共用（在 immer 草稿上调用）。
 *
 * 状态：open（等人接手）→ claimed（某个 agent 在做）→ done（做完，留一句说明）；
 * 作者随时可以 cancel。任务本身不改正文，agent 照常提建议，由作者确认。
 */
import type { AgentTask, ProjectData, SuggestionTarget } from '../types'
import { nowISO, uid } from './ids'

export interface NewTask {
  instruction: string
  target: SuggestionTarget
  quote: string
  section?: string
}

export function tasksOf(d: ProjectData): AgentTask[] {
  return d.tasks ?? []
}

export function isActive(t: AgentTask): boolean {
  return t.state === 'open' || t.state === 'claimed'
}

export function createTask(d: ProjectData, input: NewTask): string {
  const task: AgentTask = {
    id: uid('t'),
    instruction: input.instruction.trim(),
    target: input.target,
    quote: input.quote,
    ...(input.section ? { section: input.section } : {}),
    state: 'open',
    createdAt: nowISO(),
  }
  d.tasks = [...tasksOf(d), task]
  return task.id
}

function find(d: ProjectData, id: string): AgentTask | undefined {
  return d.tasks?.find((t) => t.id === id)
}

/** 作者取消：只有还没做完的才能取消 */
export function cancelTask(d: ProjectData, id: string): boolean {
  const t = find(d, id)
  if (!t || !isActive(t)) return false
  t.state = 'cancelled'
  return true
}

/** 从列表里移除已结束的任务 */
export function removeTask(d: ProjectData, id: string): boolean {
  const t = find(d, id)
  if (!t || isActive(t)) return false
  d.tasks = tasksOf(d).filter((x) => x.id !== id)
  return true
}

export type ClaimResult = { ok: true; task: AgentTask } | { ok: false; reason: 'not_found' | 'taken' | 'closed'; task?: AgentTask }

/** agent 接手；同一个 agent 重复接手视为成功 */
export function claimTask(d: ProjectData, id: string, author: string): ClaimResult {
  const t = find(d, id)
  if (!t) return { ok: false, reason: 'not_found' }
  if (t.state === 'claimed' && t.claimedBy !== author) return { ok: false, reason: 'taken', task: t }
  if (!isActive(t)) return { ok: false, reason: 'closed', task: t }
  if (t.state === 'open') {
    t.state = 'claimed'
    t.claimedBy = author
    t.claimedAt = nowISO()
  }
  return { ok: true, task: t }
}

/** agent 做完：没接手过的可以直接完成（顺带记为接手） */
export function completeTask(d: ProjectData, id: string, author: string, summary?: string): ClaimResult {
  const claimed = claimTask(d, id, author)
  if (!claimed.ok) return claimed
  const t = claimed.task
  t.state = 'done'
  t.doneAt = nowISO()
  if (summary?.trim()) t.summary = summary.trim()
  return { ok: true, task: t }
}

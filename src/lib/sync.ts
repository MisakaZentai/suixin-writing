/**
 * 绑定文件被外部程序（agent）改动后，如何与 App 里的文稿对齐。
 *
 * - 外部只增减了建议、没动正文（agent 默认的"提建议"模式）：合并建议即可，
 *   本地未保存的改动不受影响——建议自带原文，原文变了会自动标记过期；
 * - 外部改了正文、本地没有未保存的改动：直接载入外部版本；
 * - 外部改了正文、本地也有未保存的改动：冲突，交给作者选择保留哪一份。
 */
import { produce } from 'immer'
import type { AgentTask, AgentTaskState, ProjectData } from '../types'
import { describeExternalChange } from './doc'

export type Reconcile =
  | { action: 'merge'; data: ProjectData; summary: string }
  | { action: 'replace'; data: ProjectData; summary: string }
  | { action: 'conflict'; data: ProjectData; summary: string }

function blocksEqual(a: ProjectData, b: ProjectData): boolean {
  if (a.blocks.length !== b.blocks.length) return false
  return a.blocks.every((x, i) => {
    const y = b.blocks[i]
    return x.id === y.id && x.text === y.text && x.type === y.type && (x.type !== 'heading' || (y.type === 'heading' && x.level === y.level))
  })
}

const TASK_RANK: Record<AgentTaskState, number> = { open: 0, claimed: 1, done: 2, cancelled: 3 }

export function summarize(local: ProjectData, external: ProjectData): string {
  const { suggestionsBy, changedBlocks } = describeExternalChange(local, external)
  const parts = Object.entries(suggestionsBy).map(([who, n]) => `${who} 提了 ${n} 条建议`)
  if (changedBlocks) parts.push(`正文有 ${changedBlocks} 处变化`)
  const before = new Map((local.tasks ?? []).map((t) => [t.id, t.state]))
  for (const t of external.tasks ?? []) {
    const was = before.get(t.id)
    if (t.state === 'done' && was !== 'done') parts.push(`${t.claimedBy ?? 'Agent'} 完成了任务`)
    else if (t.state === 'claimed' && was === 'open') parts.push(`${t.claimedBy ?? 'Agent'} 接手了任务`)
  }
  return parts.join('，') || '内容有变化'
}

/**
 * 任务按 id 合并：外部（agent）只会往前推进状态（接手 / 完成），
 * 作者在这边取消或移除的，以这边为准。
 */
function mergeTasks(base: ProjectData, local: AgentTask[] | undefined, external: AgentTask[] | undefined): AgentTask[] | undefined {
  if (!external?.length) return local
  const inBase = new Set((base.tasks ?? []).map((t) => t.id))
  const out = [...(local ?? [])]
  for (const ext of external) {
    const i = out.findIndex((t) => t.id === ext.id)
    if (i < 0) {
      if (!inBase.has(ext.id)) out.push(ext)
    } else if (out[i].state !== 'cancelled' && TASK_RANK[ext.state] > TASK_RANK[out[i].state]) {
      out[i] = ext
    }
  }
  return out
}

/**
 * @param base    上次与文件同步时的文稿（App 读入或写出的那一版）
 * @param local   App 里当前的文稿
 * @param external 文件里现在的文稿
 * @param localDirty App 这边是否有还没写进文件的改动
 */
export function reconcile(base: ProjectData, local: ProjectData, external: ProjectData, localDirty: boolean): Reconcile {
  const summary = summarize(base, external)
  const externalTouchedText = !blocksEqual(base, external) || base.meta.title !== external.meta.title || base.brief !== external.brief
  if (!externalTouchedText) {
    // 只动了建议：把外部新增的建议并进来，外部改了状态的（撤回 / 处理）同步过来
    const data = produce(local, (d) => {
      const byId = new Map(d.suggestions.map((s) => [s.id, s]))
      for (const s of external.suggestions) {
        const mine = byId.get(s.id)
        if (!mine) d.suggestions.push(s)
        else if (mine.state === 'pending' && s.state !== 'pending') mine.state = s.state
      }
      if (external.meta.agentAccess !== base.meta.agentAccess) {
        // 权限只能由作者在 App 里改：外部改动一律忽略
      }
    })
    const tasks = mergeTasks(base, local.tasks, external.tasks)
    return { action: 'merge', data: tasks === local.tasks ? data : { ...data, tasks }, summary }
  }
  // 外部改了正文；权限字段始终以 App 为准，防止外部程序自己给自己授权
  const guarded = produce(external, (d) => {
    d.meta.agentAccess = local.meta.agentAccess
  })
  return localDirty ? { action: 'conflict', data: guarded, summary } : { action: 'replace', data: guarded, summary }
}

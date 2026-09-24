/**
 * 执行一批 agent 操作：要么全部成功，要么文稿保持原样。
 */
import type { FlavorBaseline } from '../lib/flavor/analyze'
import { produce } from 'immer'
import type { ProjectData } from '../types'
import { uid } from '../lib/ids'
import { AgentError, toAgentError } from './errors'
import { getOp, type AgentContext, type AgentMode } from './ops'
import { validate } from './schema'

export interface OpCall {
  op: string
  [param: string]: unknown
}

export interface RunOptions {
  /** agent 的显示名 */
  author: string
  /** 请求直接修改（需作者已授权） */
  direct?: boolean
  /** 作者的 AI 味个人基线 */
  baseline?: FlavorBaseline | null
}

export type RunResult =
  | { ok: true; data: ProjectData; changed: boolean; changeset: string; mode: AgentMode; results: unknown[] }
  | { ok: false; error: ReturnType<AgentError['toJSON']>; index?: number }

export function runOps(data: ProjectData, calls: OpCall[], opts: RunOptions): RunResult {
  const granted = data.meta.agentAccess === 'direct'
  if (opts.direct && !granted) {
    return {
      ok: false,
      error: new AgentError(
        'NOT_AUTHORIZED',
        '作者没有授权直接修改这篇文稿',
        '去掉 --direct 以"提建议"的方式修改；或请作者在 App 的「AI → Agent 访问」里授权'
      ).toJSON(),
    }
  }
  const ctx: AgentContext = {
    author: opts.author.trim() || 'Agent',
    baseline: opts.baseline,
    mode: opts.direct ? 'direct' : 'propose',
    changeset: uid('cs'),
    edits: new Map(),
  }
  const results: unknown[] = []
  let failedAt = -1
  try {
    const next = produce(data, (draft) => {
      calls.forEach((call, i) => {
        failedAt = i
        if (!call || typeof call.op !== 'string') {
          throw new AgentError('INVALID_PARAMS', '每个操作都需要 op 字段', '例如 {"op": "replace", "target": {…}, "text": "…"}')
        }
        const { op, ...params } = call
        const spec = getOp(op)
        validate(spec.params, params)
        if (spec.directOnly && ctx.mode !== 'direct') {
          throw new AgentError(
            'NOT_AUTHORIZED',
            `${op} 会改动文稿结构，只能在作者授权直接修改后使用`,
            granted ? '加上 --direct（作者已授权）' : '改用 note 把建议告诉作者，或请作者在 App 的「AI → Agent 访问」里授权'
          )
        }
        // 结果里可能引用草稿里的对象（如建议的 target），produce 结束后这些代理就失效了；
        // 趁还在草稿里转成普通 JSON（本来就要以 JSON 输出）
        const out = spec.run(draft as ProjectData, params, ctx)
        results.push(out === undefined ? out : JSON.parse(JSON.stringify(out)))
      })
      failedAt = -1
    })
    return { ok: true, data: next, changed: next !== data, changeset: ctx.changeset, mode: ctx.mode, results }
  } catch (e) {
    return { ok: false, error: toAgentError(e).toJSON(), ...(failedAt >= 0 ? { index: failedAt } : {}) }
  }
}

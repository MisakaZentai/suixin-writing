/** 给 agent 的错误：稳定的错误码 + 能照着改的提示 */
export type AgentErrorCode =
  | 'INVALID_PARAMS'
  | 'UNKNOWN_OP'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'NOT_AUTHORIZED'
  | 'STALE'
  | 'CONFLICT'
  | 'UNSUPPORTED'
  | 'IO'
  /** 实时桥：App 还在启动 / 没开 */
  | 'UNAVAILABLE'
  /** 实时桥：App 或作者没有及时回应 */
  | 'TIMEOUT'

export class AgentError extends Error {
  constructor(
    public code: AgentErrorCode,
    message: string,
    public hint?: string,
    public candidates?: unknown[]
  ) {
    super(message)
    this.name = 'AgentError'
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.candidates ? { candidates: this.candidates } : {}),
    }
  }
}

export function toAgentError(e: unknown): AgentError {
  if (e instanceof AgentError) return e
  return new AgentError('IO', (e as Error)?.message || String(e))
}

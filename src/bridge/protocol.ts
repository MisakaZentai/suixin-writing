/**
 * 实时桥协议（App ↔ 本机 agent）。App 与命令行共用这份定义。
 *
 * 传输：App 启动时在 127.0.0.1 的随机端口开一个 HTTP 服务，端口与令牌写在
 * 应用数据目录的 bridge.json；agent 发 `POST /rpc`，带 `Authorization: Bearer <token>`，
 * 请求体 {method, params, agent}，回复 {ok, result} 或 {ok: false, error}。
 */

export const BRIDGE_PROTOCOL = 1

export interface BridgeDiscovery {
  port: number
  token: string
  pid: number
  version: number
}

export interface BridgeRequest {
  method: string
  params: Record<string, unknown>
  /** agent 的显示名 */
  agent: string
}

export interface BridgeError {
  code: string
  message: string
  hint?: string
  candidates?: unknown[]
}

export type BridgeResponse = { ok: true; result: unknown } | { ok: false; error: BridgeError; index?: number }

/** 方法一览（events.wait 与 hello 由 Rust 直接处理，其余交给 App 执行） */
export type BridgeMethod =
  | 'hello'
  | 'events.wait'
  | 'app.status'
  | 'doc.selection'
  | 'doc.operate'
  | 'access.request'
  /** 存一张图进文稿的资源文件夹：{file?, data: base64, ext, dryRun?} → {handled, src} */
  | 'asset.put'
  /** 读出一张图：{file?, src} → {handled, data: base64, path} */
  | 'asset.read'

/** 事件里用来指明是哪篇文稿 */
export interface DocRef {
  id: string
  title: string
  /** 绑定的文件；只在文稿库里的为 null */
  path: string | null
}

export type BridgeEventType =
  | 'document.opened'
  | 'document.closed'
  | 'selection.changed'
  | 'suggestion.resolved'
  | 'task.created'
  | 'task.cancelled'
  | 'access.changed'

export interface BridgeEvent {
  type: BridgeEventType
  at: string
  document: DocRef | null
  [key: string]: unknown
}

export interface AgentPresence {
  name: string
  /** 最近一次请求（毫秒时间戳） */
  lastSeen: number
  /** 正在等待事件（长轮询中） */
  waiting: boolean
}

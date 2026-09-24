/**
 * 命令行 / MCP 这一端的实时桥：找到正在运行的随心写作，把请求交给它。
 * 找不到（App 没开、bridge.json 过期）就返回 null，调用方退回直接读写文件。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentError, type AgentErrorCode } from '../src/agent/errors'
import type { BridgeDiscovery, BridgeMethod, BridgeResponse } from '../src/bridge/protocol'

/** 与 tauri.conf.json 的 identifier 一致：应用数据目录的名字 */
const APP_ID = 'com.aiwriter.app'

type Env = Record<string, string | undefined>

export function discoveryPath(env: Env): string | null {
  if (env.SUIXIN_BRIDGE) return env.SUIXIN_BRIDGE
  return appDataFile(env, 'bridge.json')
}

/** 应用数据目录里的文件（与 Tauri 的 appDataDir 一致） */
export function appDataFile(env: Env, name: string): string | null {
  if (process.platform === 'win32') return env.APPDATA ? path.join(env.APPDATA, APP_ID, name) : null
  const home = env.HOME || os.homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_ID, name)
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), APP_ID, name)
}

/** App 不在：连不上，或 bridge.json 是上次运行留下的 */
export class BridgeOffline extends Error {
  constructor() {
    super('App 没有运行')
  }
}

export interface BridgeClient {
  discovery: BridgeDiscovery
  call: (method: BridgeMethod, params?: Record<string, unknown>) => Promise<unknown>
}

export async function connectBridge(env: Env, agent: string): Promise<BridgeClient | null> {
  if (env.SUIXIN_NO_BRIDGE === '1') return null
  const file = discoveryPath(env)
  if (!file) return null
  let d: BridgeDiscovery
  try {
    d = JSON.parse(await fs.readFile(file, 'utf8')) as BridgeDiscovery
  } catch {
    return null
  }
  if (!d || typeof d.port !== 'number' || typeof d.token !== 'string') return null
  return { discovery: d, call: (method, params = {}) => rpc(d, method, params, agent) }
}

/** 请求要等多久：长轮询与等作者授权都比普通请求久 */
function timeoutFor(method: BridgeMethod): number {
  if (method === 'access.request') return 200_000
  if (method === 'events.wait') return 40_000
  return 40_000
}

async function rpc(d: BridgeDiscovery, method: BridgeMethod, params: Record<string, unknown>, agent: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${d.port}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params, agent }),
      signal: AbortSignal.timeout(timeoutFor(method)),
    })
  } catch (e) {
    if ((e as Error)?.name === 'TimeoutError') throw new AgentError('TIMEOUT', 'App 没有及时回复', '稍后重试')
    throw new BridgeOffline()
  }
  // 令牌对不上：端口被别的程序占了，或是旧文件
  if (res.status === 401 || res.status === 403) throw new BridgeOffline()
  let body: BridgeResponse
  try {
    body = (await res.json()) as BridgeResponse
  } catch {
    throw new BridgeOffline()
  }
  if (!body.ok) {
    const { code, message, hint, candidates } = body.error
    const err = new AgentError(code as AgentErrorCode, message, hint, candidates)
    throw body.index !== undefined ? Object.assign(err, { index: body.index }) : err
  }
  return body.result
}

export function offlineError(): AgentError {
  return new AgentError(
    'UNAVAILABLE',
    '随心写作没有运行，连不上实时通道',
    '请作者打开随心写作；或者直接给出 .suixin.json 文件路径（不用 @）'
  )
}

/** 只能经实时桥完成的请求：App 不在就报错 */
export async function requireBridge(env: Env, agent: string): Promise<BridgeClient> {
  const b = await connectBridge(env, agent)
  if (!b) throw offlineError()
  return b
}

/** 调用并把"连不上"翻译成给 agent 看的错误 */
export async function callOnline(b: BridgeClient, method: BridgeMethod, params?: Record<string, unknown>): Promise<unknown> {
  try {
    return await b.call(method, params)
  } catch (e) {
    if (e instanceof BridgeOffline) throw offlineError()
    throw e
  }
}

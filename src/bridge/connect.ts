/**
 * 接通实时桥。
 * - 桌面版：Rust 侧转来的请求交给 handler，回复与事件经 Tauri 命令送回；
 * - 开发模式的浏览器（端到端测试）：把同一个 handler 挂到 window 上，
 *   由测试里模拟 Rust 的本机服务来驱动。
 */
import { isTauri } from '../lib/platform'
import { useBridgeStore } from '../store/bridgeStore'
import { handleBridgeRequest } from './handler'
import { startEventPublishing, type Publish } from './events'
import type { AgentPresence, BridgeEvent, BridgeRequest } from './protocol'

let started = false

export async function startBridge(): Promise<void> {
  if (started) return
  started = true
  if (isTauri) {
    await startDesktop()
  } else if (import.meta.env.DEV) {
    exposeForTests()
  }
}

async function startDesktop(): Promise<void> {
  const [{ listen }, { invoke }] = await Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core')])
  await listen<BridgeRequest & { id: number }>('bridge://request', async (e) => {
    const { id, ...req } = e.payload
    const response = await handleBridgeRequest(req)
    await invoke('bridge_respond', { id, response }).catch(() => {})
  })
  await listen<AgentPresence[]>('bridge://presence', (e) => useBridgeStore.getState().setAgents(e.payload))
  startEventPublishing((event) => void invoke('bridge_publish', { event }).catch(() => {}))
  try {
    const info = await invoke<{ port: number | null; agents: AgentPresence[] }>('bridge_ready')
    if (info.port) useBridgeStore.getState().setOnline(info.port)
    useBridgeStore.getState().setAgents(info.agents ?? [])
  } catch {
    /* 实时桥没开起来：agent 仍可直接读写文件 */
  }
}

declare global {
  interface Window {
    __suixinBridge?: {
      handle: (req: BridgeRequest) => ReturnType<typeof handleBridgeRequest>
      setAgents: (agents: AgentPresence[]) => void
      /** 测试用：事件交给这个函数（由 Playwright exposeFunction 提供） */
      connect: (publishName: string) => void
    }
  }
}

function exposeForTests(): void {
  let stop: (() => void) | null = null
  window.__suixinBridge = {
    handle: handleBridgeRequest,
    setAgents: (agents) => useBridgeStore.getState().setAgents(agents),
    connect: (publishName) => {
      stop?.()
      const fn = (window as unknown as Record<string, (e: BridgeEvent) => void>)[publishName]
      const publish: Publish = (e) => fn?.(e)
      stop = startEventPublishing(publish)
      useBridgeStore.getState().setOnline(null)
    },
  }
}

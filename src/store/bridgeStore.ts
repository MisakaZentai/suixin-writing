/**
 * 实时桥的界面状态：通道是否开着、哪些 agent 在线、待作者回应的授权请求。
 */
import { create } from 'zustand'
import type { AgentPresence } from '../bridge/protocol'

export interface AccessRequest {
  id: number
  agent: string
  reason: string
  /** 发起时打开的文稿；作者回应前切走了就算拒绝 */
  docId: string
  title: string
  resolve: (granted: boolean) => void
}

interface BridgeStore {
  /** 实时通道已开启（桌面版） */
  online: boolean
  port: number | null
  agents: AgentPresence[]
  accessRequests: AccessRequest[]

  setOnline: (port: number | null) => void
  setAgents: (agents: AgentPresence[]) => void
  /** 请作者授权；同一个 agent 对同一篇文稿的重复请求合并成一个 */
  askAccess: (input: Omit<AccessRequest, 'id' | 'resolve'>) => Promise<boolean>
  answerAccess: (id: number, granted: boolean) => void
}

let seq = 0

export const useBridgeStore = create<BridgeStore>((set, get) => ({
  online: false,
  port: null,
  agents: [],
  accessRequests: [],

  setOnline: (port) => set({ online: true, port }),
  setAgents: (agents) => set({ agents }),

  askAccess: (input) => {
    const same = get().accessRequests.find((r) => r.agent === input.agent && r.docId === input.docId)
    if (same) {
      return new Promise((resolve) => {
        const prev = same.resolve
        same.resolve = (g) => {
          prev(g)
          resolve(g)
        }
      })
    }
    return new Promise((resolve) => {
      set((s) => ({ accessRequests: [...s.accessRequests, { ...input, id: ++seq, resolve }] }))
    })
  },

  answerAccess: (id, granted) => {
    const req = get().accessRequests.find((r) => r.id === id)
    if (!req) return
    set((s) => ({ accessRequests: s.accessRequests.filter((r) => r.id !== id) }))
    req.resolve(granted)
  },
}))

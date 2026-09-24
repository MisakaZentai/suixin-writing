/**
 * AI 服务配置仓库（应用级）。
 * 所有改动即时保存；Key 按服务商存入系统安全区（浏览器模式降级为 localStorage）。
 */
import { create } from 'zustand'
import {
  LEGACY_SECRET_NAME,
  loadAIConfig,
  providerById,
  saveAIConfig,
  secretNameFor,
  temperatureOf,
  type AIServiceConfig,
} from '../lib/aiConfig'
import { secret } from '../lib/platform'
import type { AIConfig } from '../lib/ai'

interface AIConfigStore {
  config: AIServiceConfig
  /** 当前服务商是否已保存 Key */
  keyPresent: boolean

  /** 切换服务商：接口地址与模型换成该服务商的默认值 */
  selectProvider: (id: string) => Promise<void>
  update: (patch: Partial<Omit<AIServiceConfig, 'provider'>>) => void
  saveKey: (key: string) => Promise<void>
  deleteKey: () => Promise<void>
  refreshKeyPresence: () => Promise<void>
  /** 组装一次请求所需的完整配置；没有 Key 时返回 null */
  resolve: () => Promise<AIConfig | null>
}

async function readKey(provider: string): Promise<string | null> {
  const key = await secret.get(secretNameFor(provider))
  if (key) return key
  // 旧版本的全局 Key：迁移到当前服务商名下
  const legacy = await secret.get(LEGACY_SECRET_NAME)
  if (!legacy) return null
  await secret.set(secretNameFor(provider), legacy)
  await secret.del(LEGACY_SECRET_NAME)
  return legacy
}

export const useAIConfigStore = create<AIConfigStore>((set, get) => ({
  config: loadAIConfig(),
  keyPresent: false,

  selectProvider: async (id) => {
    const preset = providerById(id)
    const prev = get().config
    const next: AIServiceConfig =
      preset.id === 'custom'
        ? { ...prev, provider: 'custom' }
        : { ...prev, provider: preset.id, baseURL: preset.baseURL, model: preset.model }
    saveAIConfig(next)
    set({ config: next })
    await get().refreshKeyPresence()
  },

  update: (patch) => {
    const next = { ...get().config, ...patch }
    saveAIConfig(next)
    set({ config: next })
  },

  saveKey: async (key) => {
    const trimmed = key.trim()
    if (!trimmed) return
    await secret.set(secretNameFor(get().config.provider), trimmed)
    set({ keyPresent: true })
  },

  deleteKey: async () => {
    await secret.del(secretNameFor(get().config.provider))
    set({ keyPresent: false })
  },

  refreshKeyPresence: async () => {
    const key = await readKey(get().config.provider)
    set({ keyPresent: Boolean(key) })
  },

  resolve: async () => {
    const { config } = get()
    const apiKey = await readKey(config.provider)
    set({ keyPresent: Boolean(apiKey) })
    if (!apiKey || !config.baseURL.trim()) return null
    return {
      baseURL: config.baseURL.trim(),
      apiKey,
      model: config.model.trim(),
      temperature: temperatureOf(config.style),
    }
  },
}))

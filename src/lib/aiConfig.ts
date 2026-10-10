/**
 * AI 服务配置（应用级，不随文稿走）。
 *
 * 接口地址、模型与风格存在本机偏好里；Key 按服务商分别存入系统安全区。
 * 工程文件里即使带有接口地址也不参与请求——否则打开一份陌生工程文件，
 * 就会把本机的 Key 发到文件作者指定的地址。
 */

export interface ProviderPreset {
  id: string
  name: string
  baseURL: string
  model: string
  /** 模型名候选（仅作输入提示，可自由填写） */
  models: string[]
  /** 同一服务的几个地域端点（第一个与 baseURL 相同） */
  regions?: { label: string; baseURL: string }[]
  /** Key 的固定前缀：粘贴的 Key 对不上时提醒（套餐 Key 与按量 Key 不能混用） */
  keyPrefixes?: string[]
  /** 选中时显示的一句说明 */
  note?: string
  /** 订阅套餐（Token Plan / 会员额度）：设置里与按量付费分开列 */
  plan?: boolean
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'moonshot-v1-32k'],
    note: 'Kimi 开放平台，按量计费。用的是 Kimi 会员额度请选「Kimi Code 会员」。',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
  },
  {
    id: 'mimo',
    name: '小米 MiMo',
    baseURL: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.6-pro',
    models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
    keyPrefixes: ['sk-'],
    note: '按量计费。买的是 Token Plan 套餐请选「MiMo Token Plan」，两种 Key 不能混用。',
  },
  {
    id: 'mimo-token-plan',
    name: 'MiMo Token Plan',
    baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.6-pro',
    models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
    regions: [
      { label: '中国', baseURL: 'https://token-plan-cn.xiaomimimo.com/v1' },
      { label: '新加坡', baseURL: 'https://token-plan-sgp.xiaomimimo.com/v1' },
      { label: '欧洲', baseURL: 'https://token-plan-ams.xiaomimimo.com/v1' },
    ],
    keyPrefixes: ['tp-', 'ttp-'],
    note: '套餐 Key 在 Token Plan 页面获取（tp- 开头），订阅到期后需续订。',
    plan: true,
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code 会员',
    baseURL: 'https://api.kimi.com/coding/v1',
    model: 'kimi-for-coding',
    models: ['kimi-for-coding', 'kimi-for-coding-highspeed'],
    regions: [
      { label: '中国', baseURL: 'https://api.kimi.com/coding/v1' },
      { label: '海外', baseURL: 'https://api.kimi.ai/coding/v1' },
    ],
    note: '用 Kimi 会员额度，Key 在 Kimi Code 控制台创建。Kimi 只对编程工具开放这组接口，可能拒绝本应用；被拒时可用「交给 Agent」，让 Kimi Code 连上随心写作来改。',
    plan: true,
  },
  {
    id: 'custom',
    name: '自定义',
    baseURL: '',
    model: '',
    models: [],
  },
]

/** 写作者能理解的"风格"，而不是 0–2 的温度数字 */
export type AIStyle = 'steady' | 'balanced' | 'creative'

export const STYLE_OPTIONS: { value: AIStyle; label: string; hint: string; temperature: number }[] = [
  { value: 'steady', label: '稳妥', hint: '贴近原文，改动克制', temperature: 0.3 },
  { value: 'balanced', label: '平衡', hint: '默认', temperature: 0.7 },
  { value: 'creative', label: '发散', hint: '更敢改，表达更多样', temperature: 1.1 },
]

export interface AIServiceConfig {
  provider: string
  baseURL: string
  model: string
  style: AIStyle
}

export const DEFAULT_AI_CONFIG: AIServiceConfig = {
  provider: 'deepseek',
  baseURL: PROVIDERS[0].baseURL,
  model: PROVIDERS[0].model,
  style: 'balanced',
}

export function providerById(id: string): ProviderPreset {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1]
}

export function temperatureOf(style: AIStyle): number {
  return STYLE_OPTIONS.find((s) => s.value === style)?.temperature ?? 0.7
}

/** 粘贴的 Key 与服务商要求的前缀对不上时，返回提醒文字 */
export function keyMismatch(preset: ProviderPreset, key: string): string | null {
  const k = key.trim()
  if (!k || !preset.keyPrefixes?.length) return null
  if (preset.keyPrefixes.some((p) => k.startsWith(p))) return null
  return `${preset.name} 的 Key 应以 ${preset.keyPrefixes.join(' 或 ')} 开头，这把可能是别的计费方式的 Key`
}

/** 每个服务商一把 Key，切换服务商不会互相覆盖 */
export function secretNameFor(provider: string): string {
  return `apiKey:${provider}`
}

/** 旧版本只有一把全局 Key，名为 apiKey */
export const LEGACY_SECRET_NAME = 'apiKey'

const STORAGE_KEY = 'suixin:ai-service'

export function loadAIConfig(): AIServiceConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_AI_CONFIG }
    const parsed = JSON.parse(raw) as Partial<AIServiceConfig>
    const style: AIStyle =
      parsed.style === 'steady' || parsed.style === 'creative' ? parsed.style : 'balanced'
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : DEFAULT_AI_CONFIG.provider,
      baseURL: typeof parsed.baseURL === 'string' ? parsed.baseURL : DEFAULT_AI_CONFIG.baseURL,
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_AI_CONFIG.model,
      style,
    }
  } catch {
    return { ...DEFAULT_AI_CONFIG }
  }
}

export function saveAIConfig(config: AIServiceConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    /* 存储不可用时仅在本次会话生效 */
  }
}

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
    model: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
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

import { describe, expect, it } from 'vitest'
import { PROVIDERS, keyMismatch, providerById } from './aiConfig'
import { codingOnlyHint } from './ai'

describe('AI 服务预设', () => {
  it('套餐与按量的 Key 前缀对不上时提醒', () => {
    const tp = providerById('mimo-token-plan')
    expect(keyMismatch(tp, 'tp-abc')).toBeNull()
    expect(keyMismatch(tp, 'sk-abc')).toContain('tp-')
    expect(keyMismatch(providerById('mimo'), 'tp-abc')).toContain('sk-')
    expect(keyMismatch(providerById('kimi-code'), 'sk-anything')).toBeNull() // 没有固定前缀就不查
  })

  it('地域端点的第一个就是默认地址；套餐单独成组', () => {
    for (const p of PROVIDERS.filter((x) => x.regions)) expect(p.regions![0].baseURL).toBe(p.baseURL)
    expect(PROVIDERS.filter((p) => p.plan).map((p) => p.id)).toEqual(['mimo-token-plan', 'kimi-code'])
  })

  it('只给编程工具用的会员接口被拒时说明原因', () => {
    expect(codingOnlyHint(403, 'https://api.kimi.com/coding/v1')).toContain('只对编程工具开放')
    expect(codingOnlyHint(403, 'https://api.moonshot.cn/v1')).toBe('')
    expect(codingOnlyHint(500, 'https://api.kimi.com/coding/v1')).toBe('')
  })
})

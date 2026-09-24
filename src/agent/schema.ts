/**
 * 操作参数的 JSON Schema（子集）与校验。
 * 同一份 schema 用于：命令行参数校验、`suixin ops` 输出、MCP 工具定义。
 */
import { AgentError } from './errors'

export interface JSONSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema
  enum?: (string | number)[]
  oneOf?: JSONSchema[]
  minimum?: number
  maximum?: number
  additionalProperties?: boolean
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

function matches(schema: JSONSchema, value: unknown, path: string): string | null {
  if (schema.oneOf) {
    const errors = schema.oneOf.map((s) => matches(s, value, path))
    return errors.some((e) => e === null) ? null : errors[0]
  }
  if (schema.type) {
    const t = typeOf(value)
    const ok = schema.type === 'number' ? t === 'number' || t === 'integer' : t === schema.type
    if (!ok) return `${path} 应为 ${schema.type}，实际是 ${t}`
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    return `${path} 只能是 ${schema.enum.map((x) => JSON.stringify(x)).join(' / ')}`
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} 不能小于 ${schema.minimum}`
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} 不能大于 ${schema.maximum}`
  }
  if (schema.type === 'array' && schema.items) {
    for (let i = 0; i < (value as unknown[]).length; i++) {
      const err = matches(schema.items, (value as unknown[])[i], `${path}[${i}]`)
      if (err) return err
    }
  }
  if (schema.type === 'object' && value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) return `缺少参数 ${path ? `${path}.` : ''}${key}`
    }
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key]
      if (!sub) {
        if (schema.additionalProperties === false) return `不认识的参数 ${path ? `${path}.` : ''}${key}`
        continue
      }
      if (v === undefined) continue
      const err = matches(sub, v, path ? `${path}.${key}` : key)
      if (err) return err
    }
  }
  return null
}

export function validate(schema: JSONSchema, value: unknown): void {
  const err = matches(schema, value, '')
  if (err) throw new AgentError('INVALID_PARAMS', err, '运行 `suixin ops` 查看每个操作的参数')
}

/* ── 常用片段 ─────────────────────────────────────── */

/** 定位：四选一 */
export const TARGET_SCHEMA: JSONSchema = {
  type: 'object',
  description:
    '定位，四选一：block（段落 id）/ blocks（连续多段的 id）/ quote（逐字引用原文中的一段文字）/ section（章节标题或其 id，指这一节的正文）',
  properties: {
    block: { type: 'string', description: '段落 id' },
    blocks: { type: 'array', items: { type: 'string' }, description: '连续多段的 id，按文档顺序' },
    quote: { type: 'string', description: '逐字引用原文中的一段文字（不能跨段）' },
    occurrence: { type: 'integer', minimum: 1, description: '引文出现多次时，取第几处（从 1 开始）' },
    in: { type: 'string', description: '只在这一段（id）或这一节（标题 / id）里找引文' },
    section: { type: 'string', description: '章节标题（逐字）或标题 id' },
  },
  additionalProperties: false,
}

/** 插入位置：在某处之后；或文首 / 文末 */
export const POSITION_SCHEMA: JSONSchema = {
  oneOf: [
    { type: 'string', enum: ['start', 'end'] },
    TARGET_SCHEMA,
  ],
  description: '"start" / "end"，或一个定位（插在它之后；定位到章节时插在该节末尾）',
}

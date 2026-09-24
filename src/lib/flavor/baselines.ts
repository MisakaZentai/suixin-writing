/**
 * AI 味的个人基线：从作者自己写的文字里统计各规则的命中密度，作者也常用的写法就有豁免额度
 * （沿用 round_score 的做法）。基线存在应用数据目录的 flavor-baselines.json，
 * App、命令行与 MCP 共用；每篇文稿可以在 meta.flavor.baseline 里选用其中一份，不选就用默认那份。
 */
import type { ProjectData } from '../../types'
import { parseDocument } from '../markdown'
import { parseProjectFile } from '../project'
import { buildBaseline, type FlavorBaseline } from './analyze'

export const BUILTIN = '内置'
export const BASELINE_FILE = 'flavor-baselines.json'

export interface BaselineStore {
  version: 1
  /** 没有单独选用时的默认基线；不填即内置人类基线 */
  default?: string
  baselines: FlavorBaseline[]
}

const EMPTY: BaselineStore = { version: 1, baselines: [] }
let current: BaselineStore = EMPTY
let revision = 0

export function getBaselineStore(): BaselineStore {
  return current
}

/** 每次换了基线就加一：检查结果的缓存靠它失效 */
export function baselineRevision(): number {
  return revision
}

export function setBaselineStore(store: BaselineStore): void {
  current = store
  revision++
}

export function parseBaselineStore(text: string | null | undefined): BaselineStore {
  if (!text) return EMPTY
  try {
    const raw = JSON.parse(text) as Partial<BaselineStore>
    const baselines = (Array.isArray(raw.baselines) ? raw.baselines : []).filter(
      (b): b is FlavorBaseline =>
        !!b && typeof b.name === 'string' && typeof b.chars === 'number' && !!b.counts && typeof b.counts === 'object'
    )
    const def = typeof raw.default === 'string' && baselines.some((b) => b.name === raw.default) ? raw.default : undefined
    return { version: 1, ...(def ? { default: def } : {}), baselines }
  } catch {
    return EMPTY
  }
}

export function serializeBaselineStore(store: BaselineStore): string {
  return JSON.stringify(store, null, 2) + '\n'
}

/** 这篇文稿用哪份基线：文稿里选的 → 默认 → 内置（null） */
export function resolveBaseline(d: ProjectData | null, store: BaselineStore = current): FlavorBaseline | null {
  const name = d?.meta.flavor?.baseline ?? store.default
  if (!name || name === BUILTIN) return null
  return store.baselines.find((b) => b.name === name) ?? null
}

export function upsertBaseline(store: BaselineStore, b: FlavorBaseline, makeDefault = false): BaselineStore {
  const baselines = [...store.baselines.filter((x) => x.name !== b.name), b]
  return { ...store, baselines, ...(makeDefault ? { default: b.name } : {}) }
}

export function removeBaseline(store: BaselineStore, name: string): BaselineStore {
  const baselines = store.baselines.filter((b) => b.name !== name)
  const next: BaselineStore = { version: 1, baselines }
  if (store.default && store.default !== name) next.default = store.default
  return next
}

export function setDefaultBaseline(store: BaselineStore, name: string | null): BaselineStore {
  const next: BaselineStore = { version: 1, baselines: store.baselines }
  if (name && name !== BUILTIN && store.baselines.some((b) => b.name === name)) next.default = name
  return next
}

/** 一份文字来源 → 用来统计的段落：工程文件取正文段落，Markdown / 纯文本按段切开 */
export function sourceParagraphs(name: string, text: string): string[] {
  if (/\.json$/i.test(name) || /^\s*\{/.test(text)) {
    try {
      const data = parseProjectFile(text)
      return data.blocks.filter((b) => b.type === 'paragraph').map((b) => b.text)
    } catch {
      /* 不是工程文件，当纯文本处理 */
    }
  }
  return parseDocument(text)
    .blocks.filter((b) => b.type === 'paragraph')
    .map((b) => b.text)
}

/** 由若干份作者原文建立基线 */
export function baselineFromSources(name: string, sources: { name: string; text: string }[]): FlavorBaseline {
  const texts = sources.flatMap((s) => sourceParagraphs(s.name, s.text))
  return buildBaseline(
    name,
    texts,
    sources.map((s) => s.name)
  )
}

/** 基线太小时统计不可靠 */
export const MIN_BASELINE_CHARS = 3000

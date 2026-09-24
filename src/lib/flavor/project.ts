/**
 * 把 AI 味检查接到文稿上：文体按整篇判断（不按片段），作者忽略过的命中不再报。
 * App、命令行、MCP、实时桥共用。
 */
import type { ProjectData } from '../../types'
import { getBlock, headingPaths, indexOfBlock, sectionEnd } from '../doc'
import { analyzeDocument, analyzeText, flavorDelta, guessGenre, type DocumentFlavor, type FlavorBaseline, type FlavorHit, type FlavorOptions } from './analyze'
import { RULES, type Genre } from './rules'
import { resolveBaseline } from './baselines'

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]))

export function paragraphText(d: ProjectData): string {
  return d.blocks
    .filter((b) => b.type === 'paragraph')
    .map((b) => b.text)
    .join('\n')
}

export function docGenre(d: ProjectData): Genre {
  return d.meta.flavor?.genre ?? guessGenre(paragraphText(d))
}

/** baseline 不传时按文稿的选择 / 默认基线解析；传 null 表示用内置基线 */
export function flavorOptions(d: ProjectData, baseline?: FlavorBaseline | null): FlavorOptions {
  return { genre: docGenre(d), ignoreHits: d.meta.flavor?.ignore, baseline: baseline === undefined ? resolveBaseline(d) : baseline }
}

/** 检查整篇，或某一节（含子节）、某几段 */
export function analyzeProject(
  d: ProjectData,
  scope: { section?: string; blockIds?: string[] } = {},
  baseline?: FlavorBaseline | null
): DocumentFlavor {
  let blocks = d.blocks
  if (scope.section) {
    const i = indexOfBlock(d, scope.section)
    blocks = d.blocks.slice(i, sectionEnd(d.blocks, i))
  } else if (scope.blockIds?.length) {
    const ids = new Set(scope.blockIds)
    blocks = d.blocks.filter((b) => ids.has(b.id))
  }
  return analyzeDocument(
    blocks.map((b) => ({ id: b.id, type: b.type, text: b.text })),
    flavorOptions(d, baseline)
  )
}

export function adviceOf(rule: string): string | undefined {
  return RULE_BY_ID.get(rule)?.advice
}

/** 给 agent 的视图：精简、带改法，命中定位可直接用于 replace（quote + in） */
export function flavorView(d: ProjectData, report: DocumentFlavor, limit = 60) {
  const paths = headingPaths(d.blocks)
  const rulesUsed = new Set(report.hits.map((h) => h.rule))
  const hitView = (h: FlavorHit) => ({
    block: h.block,
    quote: h.text,
    rule: h.rule,
    name: h.name,
    severity: h.severity,
    section: h.block ? (paths.get(h.block) ?? []).map((x) => x.text).join(' / ') || undefined : undefined,
  })
  return {
    index: report.index,
    level: report.level,
    genre: report.genre,
    chars: report.chars,
    baseline: report.baseline,
    rules: report.rules.map((r) => ({ ...r, advice: adviceOf(r.rule) })),
    findings: report.findings.map((f) => ({ name: f.name, severity: f.severity, detail: f.detail })),
    hits: report.hits.slice(0, limit).map(hitView),
    more: report.hits.length > limit ? report.hits.length - limit : undefined,
    worst: report.blocks
      .filter((b) => b.hits.length && (b.index ?? 0) > 0)
      .sort((a, b) => (b.index ?? 0) - (a.index ?? 0))
      .slice(0, 8)
      .map((b) => ({ block: b.block, index: b.index, level: b.level, hits: b.hits.length, preview: getBlock(d, b.block)?.text.slice(0, 40) })),
    advice: Object.fromEntries([...rulesUsed].map((r) => [r, adviceOf(r) ?? ''])),
    note: 'AI 味指数是相对基线的超标程度，不是"AI 写的概率"；命中只是嫌疑，由作者定案。改写时不要用一种套路替换另一种。',
  }
}

/** 检查一段尚未提交的文字（agent 自检） */
export function textView(d: ProjectData | null, text: string, genre?: Genre, baseline?: FlavorBaseline | null) {
  const r = analyzeText(text, { ...(d ? flavorOptions(d, baseline) : { baseline: resolveBaseline(null) }), ...(genre ? { genre } : {}) })
  return {
    index: r.index,
    level: r.level,
    genre: r.genre,
    hits: r.hits.map((h) => ({ quote: h.text, rule: h.rule, name: h.name, severity: h.severity, advice: adviceOf(h.rule) })),
  }
}

/** agent 提交的修改带进了新套路时，附在返回结果里提醒它 */
export function flavorWarning(d: ProjectData, before: string, after: string) {
  const delta = flavorDelta(before, after, flavorOptions(d))
  // 换了说法却还是原来的套路，也要提醒
  const reshaped = delta.kept.filter((h) => !before.includes(h.text))
  if (!delta.added.length && !reshaped.length) return undefined
  const view = (h: FlavorHit) => ({ quote: h.text, rule: h.rule, name: h.name, advice: adviceOf(h.rule) })
  return {
    added: delta.added.map(view),
    ...(reshaped.length ? { reshaped: reshaped.map(view) } : {}),
    index: { before: delta.before, after: delta.after },
    hint: '这次修改带进了新的 AI 味套路。建议撤回（withdraw）后改掉再提交；确有必要保留时在 why 里说明',
  }
}

/**
 * App 里的 AI 味：按文稿缓存检查结果（文稿一变就重算），给正文标注与面板用；
 * 作者"忽略这处"、选文体都记在文稿的 meta.flavor 里，agent 那边也认。
 */
import type { FlavorSettings, ProjectData } from '../types'
import type { DocumentFlavor, FlavorHit } from '../lib/flavor'
import { analyzeProject } from '../lib/flavor/project'
import { BUILTIN, baselineRevision } from '../lib/flavor/baselines'
import { useBaselineStore } from './baselineStore'
import { useProjectStore } from './projectStore'
import { useUIStore } from './uiStore'

interface Cached {
  revision: number
  report: DocumentFlavor
  byBlock: Map<string, FlavorHit[]>
}

const cache = new WeakMap<ProjectData, Cached>()

function cached(data: ProjectData): Cached {
  let c = cache.get(data)
  if (!c || c.revision !== baselineRevision()) {
    const report = analyzeProject(data)
    c = { revision: baselineRevision(), report, byBlock: new Map(report.blocks.filter((b) => b.hits.length).map((b) => [b.block, b.hits])) }
    cache.set(data, c)
  }
  return c
}

export function flavorReport(data: ProjectData): DocumentFlavor {
  return cached(data).report
}

const EMPTY: FlavorHit[] = []

/** 这一段的命中；AI 味面板没开时不算、不标 */
export function useBlockFlavorHits(id: string): FlavorHit[] {
  const open = useUIStore((s) => s.flavorOpen)
  useBaselineStore((s) => s.revision) // 换了基线要重算
  return useProjectStore((s) => (open && s.data ? (cached(s.data).byBlock.get(id) ?? EMPTY) : EMPTY))
}

function setFlavor(update: (f: FlavorSettings) => FlavorSettings): void {
  useProjectStore.getState().mutate((d) => {
    const next = update({ ...d.meta.flavor })
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)))
    if (Object.keys(clean).length) d.meta.flavor = clean
    else delete d.meta.flavor
  })
}

/** 作者认定"这处没问题"：之后不再标，agent 也不会再报 */
export function ignoreFlavorHit(hit: FlavorHit): void {
  const key = `${hit.rule}:${hit.text}`
  setFlavor((f) => ({ ...f, ignore: [...new Set([...(f.ignore ?? []), key])] }))
  useUIStore.getState().pushToast({
    kind: 'info',
    text: `已忽略「${hit.text.length > 12 ? hit.text.slice(0, 12) + '…' : hit.text}」`,
    actionLabel: '撤销',
    onAction: () => useProjectStore.getState().undo(),
  })
}

export function clearFlavorIgnores(): void {
  setFlavor((f) => ({ ...f, ignore: undefined }))
}

export function setFlavorGenre(genre: FlavorSettings['genre'] | 'auto'): void {
  setFlavor((f) => ({ ...f, genre: genre === 'auto' ? undefined : genre }))
}

/** 这篇文稿选用哪份基线；传 null 跟随默认 */
export function setFlavorBaseline(name: string | null): void {
  setFlavor((f) => ({ ...f, baseline: name ?? undefined }))
}

export { BUILTIN }

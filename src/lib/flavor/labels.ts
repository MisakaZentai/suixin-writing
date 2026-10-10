/**
 * 作者标注（二期 P6）：作者读着觉得"像 AI"的段落或句子。
 *
 * 存在应用数据目录的 flavor-labels.json，所有文稿共用一份，App 与命令行都能读。
 * 每条记下标注时的原文、引擎当时的判断（命中了哪些规则、指数多少）与这段是谁写的：
 * 引擎一条都没抓到的"漏网"标注最有价值，可以拿来挖新规则的候选。
 */
import type { ParagraphBlock, ProjectData, VersionSource } from '../../types'
import { uid, nowISO } from '../ids'
import { analyzeText } from './analyze'
import { flavorOptions } from './project'
import type { Genre } from './rules'

export const LABEL_FILE = 'flavor-labels.json'

export interface FlavorLabel {
  id: string
  /** 读着像 AI（以后可以加"读着像人写的"） */
  verdict: 'ai'
  /** 文稿库里的 id；浏览器模式、未保存时为 null */
  docId: string | null
  docTitle: string
  docPath?: string | null
  blockId: string
  /** 标注时这一段的全文 */
  text: string
  /** 划选了的话，是那一句；否则整段 */
  quote?: string
  genre: Genre
  /** 这一段最近一版是谁写的：作者手写、内置 AI 改写、agent…… */
  origin: VersionSource
  /** agent 名称（origin 为 agent 时） */
  originAuthor?: string
  /** 这一段有没有被 AI 改过（任何一版来自内置 AI 或 agent） */
  aiTouched: boolean
  /** 标注时引擎命中的规则（含留出的） */
  hits: string[]
  /** 标注时这一段的 AI 味指数 */
  index: number | null
  at: string
}

export interface LabelStore {
  version: 1
  labels: FlavorLabel[]
}

const EMPTY: LabelStore = { version: 1, labels: [] }

export function parseLabelStore(text: string | null | undefined): LabelStore {
  if (!text) return EMPTY
  try {
    const raw = JSON.parse(text) as Partial<LabelStore>
    const labels = (Array.isArray(raw.labels) ? raw.labels : []).filter(
      (l): l is FlavorLabel => !!l && typeof l.id === 'string' && typeof l.blockId === 'string' && typeof l.text === 'string'
    )
    return { version: 1, labels }
  } catch {
    return EMPTY
  }
}

export function serializeLabelStore(store: LabelStore): string {
  return JSON.stringify(store, null, 1) + '\n'
}

const AI_SOURCES: VersionSource[] = ['ai_rewrite', 'ai_revise', 'agent']

/** 给一段（或段里的一句）做一条标注，顺带记下引擎此刻的判断 */
export function makeLabel(
  d: ProjectData,
  block: ParagraphBlock,
  doc: { id: string | null; path?: string | null },
  quote?: string
): FlavorLabel {
  const opts = flavorOptions(d)
  const report = analyzeText(quote || block.text, opts)
  const last = block.versions[block.versions.length - 1]
  return {
    id: uid('lb'),
    verdict: 'ai',
    docId: doc.id,
    docTitle: d.meta.title,
    docPath: doc.path ?? null,
    blockId: block.id,
    text: block.text,
    ...(quote ? { quote } : {}),
    genre: report.genre,
    origin: last?.source ?? 'manual',
    ...(last?.author ? { originAuthor: last.author } : {}),
    aiTouched: block.versions.some((v) => AI_SOURCES.includes(v.source)),
    hits: [...new Set(report.hits.map((h) => h.rule))],
    index: report.index,
    at: nowISO(),
  }
}

export function addLabel(store: LabelStore, label: FlavorLabel): LabelStore {
  return { version: 1, labels: [...store.labels, label] }
}

export function removeLabel(store: LabelStore, id: string): LabelStore {
  return { version: 1, labels: store.labels.filter((l) => l.id !== id) }
}

/** 这篇文稿里的标注：文稿库 id 对得上；没有 id 时按标题 */
export function labelsOfDoc(store: LabelStore, doc: { id: string | null; title: string }): FlavorLabel[] {
  return store.labels.filter((l) => (doc.id ? l.docId === doc.id : !l.docId && l.docTitle === doc.title))
}

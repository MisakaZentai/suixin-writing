/**
 * 文本对照：按"词"比较（Intl.Segmenter 分词后交给 diff-match-patch），
 * 再按分句把相邻的改动聚成一"处"——既不会把一个词拆成红绿碎片，
 * 也不会让一整段只剩一处"全部重写"。
 */
import DiffMatchPatch from 'diff-match-patch'
import type { DiffOp } from '../types'

const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 1

const wordSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('zh', { granularity: 'word' })
    : null

function tokenize(text: string): string[] {
  if (!wordSegmenter) return Array.from(text)
  const out: string[] = []
  for (const part of wordSegmenter.segment(text)) out.push(part.segment)
  return out
}

/** 计算 old → new 的操作流（按词对齐，语义清理后合并同类项） */
export function computeDiff(oldText: string, newText: string): DiffOp[] {
  if (oldText === newText) return oldText ? [{ op: 'keep', text: oldText }] : []
  const vocab = new Map<string, number>()
  const tokens: string[] = []
  const encode = (text: string): string | null => {
    let out = ''
    for (const t of tokenize(text)) {
      let code = vocab.get(t)
      if (code === undefined) {
        code = tokens.length
        // 超过 BMP 可编码的词表：退回字符级
        if (code >= 0xd800) return null
        tokens.push(t)
        vocab.set(t, code)
      }
      out += String.fromCharCode(code)
    }
    return out
  }
  const a = encode(oldText)
  const b = a === null ? null : encode(newText)
  let raw: [number, string][]
  if (a !== null && b !== null) {
    raw = dmp
      .diff_main(a, b, false)
      .map(([op, enc]) => [op, Array.from(enc, (ch) => tokens[ch.charCodeAt(0)]).join('')])
  } else {
    raw = dmp.diff_main(oldText, newText)
  }
  dmp.diff_cleanupSemantic(raw as DiffMatchPatch.Diff[])
  const ops: DiffOp[] = []
  for (const [op, text] of raw) {
    if (!text) continue
    const kind: DiffOp['op'] = op === -1 ? 'del' : op === 1 ? 'ins' : 'keep'
    const last = ops[ops.length - 1]
    if (last && last.op === kind) last.text += text
    else ops.push({ op: kind, text })
  }
  return ops
}

/** 一"处"改动：ops 中 [start, end] 闭区间，两端必是改动，中间可夹短的未改文字 */
export interface DiffCluster {
  id: number
  start: number
  end: number
}

/** 两处改动之间的未改文字足够短、且不跨分句时，视为同一处 */
const BOUNDARY = /[，。！？；：、,.!?;:\n]/
const MAX_GAP = 6

export function clusterize(ops: DiffOp[]): DiffCluster[] {
  const clusters: DiffCluster[] = []
  let current: DiffCluster | null = null
  let gap = ''
  ops.forEach((op, i) => {
    if (op.op === 'keep') {
      if (current) gap += op.text
      return
    }
    if (current && gap.length <= MAX_GAP && !BOUNDARY.test(gap)) {
      current.end = i
    } else {
      current = { id: clusters.length, start: i, end: i }
      clusters.push(current)
    }
    gap = ''
  })
  return clusters
}

/** 第 i 个操作属于哪一处（不在任何一处时返回 -1） */
export function clusterIndexOf(clusters: DiffCluster[], opIndex: number): number {
  return clusters.findIndex((c) => opIndex >= c.start && opIndex <= c.end)
}

/**
 * 按每一处的裁决还原最终文本。未裁决的按"接受"处理。
 * 接受：保留新增、去掉删除；拒绝：保留删除、去掉新增。
 */
export function applyDecisions(ops: DiffOp[], decisions: (boolean | undefined)[]): string {
  const clusters = clusterize(ops)
  let out = ''
  ops.forEach((op, i) => {
    if (op.op === 'keep') {
      out += op.text
      return
    }
    const c = clusterIndexOf(clusters, i)
    const accepted = decisions[c] !== false
    if (op.op === 'ins' && accepted) out += op.text
    if (op.op === 'del' && !accepted) out += op.text
  })
  return out
}

/** 改动比例：改动字数 / 前后总字数。超过一半视为"整体重写" */
export function changeRatio(ops: DiffOp[]): number {
  let changed = 0
  let total = 0
  for (const op of ops) {
    const n = op.text.length
    total += op.op === 'keep' ? 2 * n : n
    if (op.op !== 'keep') changed += n
  }
  return total ? changed / total : 0
}

export const WHOLE_REWRITE_RATIO = 0.5

/**
 * 文本 diff（spec §7：diff-match-patch，字符级）。
 * 输出统一为 keep/del/ins 操作流，并按“变更簇”分组（spec F4 / design §5.5）：
 * 相邻的改动聚为一簇，间隔过短的 keep 序列视为同一簇，避免簇过于碎裂。
 */
import DiffMatchPatch from 'diff-match-patch'
import type { DiffOp } from '../types'

export interface DiffCluster {
  id: number
  /** 该簇在 ops 流中的下标 */
  opIndices: number[]
  /** 簇内改动操作（del/ins），按原顺序 */
  ops: DiffOp[]
}

const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 2 // 超限则用次优解，保证 <200ms（spec §8）

/** 计算字符级 diff 操作流 */
export function computeDiff(oldText: string, newText: string): DiffOp[] {
  if (oldText === newText) return [{ op: 'keep', text: oldText }]
  const raw = dmp.diff_main(oldText, newText)
  dmp.diff_cleanupSemantic(raw)
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

/** 是否“相邻到值得合并”：间隔 ≤ 2 个字符的改动视为同一处 */
const CLUSTER_GAP = 2

export function clusterize(ops: DiffOp[]): DiffCluster[] {
  const clusters: DiffCluster[] = []
  let current: DiffCluster | null = null
  let keepRun = 0
  ops.forEach((op, i) => {
    if (op.op === 'keep') {
      if (current) {
        keepRun += op.text.length
        if (keepRun > CLUSTER_GAP) current = null
      }
      return
    }
    if (!current) {
      current = { id: clusters.length, opIndices: [], ops: [] }
      clusters.push(current)
      keepRun = 0
    }
    current.opIndices.push(i)
    current.ops.push(op)
  })
  return clusters
}

/**
 * 按每簇的接受/拒绝决策还原最终文本。
 * 接受：保留 ins、丢弃 del；拒绝：保留 del、丢弃 ins。
 */
export function applyDecisions(
  ops: DiffOp[],
  decisions: boolean[] | undefined
): string {
  const clusters = clusterize(ops)
  const acceptedSet = new Set<number>()
  clusters.forEach((c, i) => {
    if (!decisions || decisions[i] === undefined) acceptedSet.add(c.id) // 默认接受（全部接受路径）
    else if (decisions[i]) acceptedSet.add(c.id)
  })
  let out = ''
  ops.forEach((op, i) => {
    if (op.op === 'keep') {
      out += op.text
      return
    }
    const cluster = clusters.find((c) => c.opIndices.includes(i))
    const accepted = cluster ? acceptedSet.has(cluster.id) : true
    if (op.op === 'ins' && accepted) out += op.text
    if (op.op === 'del' && !accepted) out += op.text
  })
  return out
}

/** 提取纯“新增预览文本”（用于侧栏/待办展示） */
export function diffNewText(ops: DiffOp[]): string {
  return ops
    .filter((o) => o.op !== 'del')
    .map((o) => o.text)
    .join('')
}

/** 变化字数（用于判断 AI 是否真的做了改动） */
export function diffChangedCount(ops: DiffOp[]): number {
  return ops
    .filter((o) => o.op !== 'keep')
    .reduce((n, o) => n + o.text.length, 0)
}

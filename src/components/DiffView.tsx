/**
 * 内联 diff 视图（spec F4 / design §5.5「信任的舞台」）。
 * 就地呈现；簇内删在上、增在下；逐处 ✓/✗；焦点环 + 周围内容降透明。
 *
 * 修复要点：
 * - 拒绝后原文恢复为正常文本（去掉删除线）
 * - 接受后 ins 文字色过渡到主文字色（wash-green）
 * - 簇 cascade 入场（每簇延迟 40ms）
 * - 焦点环 spring 过渡，非聚焦簇降透明度
 * - 滚动定位用 data-cluster-first 精确命中簇首元素
 */
import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import type { DiffOp } from '../types'
import { clusterize } from '../lib/diff'
import { IconCheck, IconX } from './icons'

interface Props {
  ops: DiffOp[]
  decisions: (boolean | undefined)[]
  focused: number
  onChangeFocus: (index: number) => void
  onDecide: (index: number, accepted: boolean) => void
  onAcceptAll: () => void
  onRejectAll: () => void
}

export function DiffView({
  ops,
  decisions,
  focused,
  onChangeFocus,
  onDecide,
  onAcceptAll,
  onRejectAll,
}: Props) {
  const clusters = useMemo(() => clusterize(ops), [ops])
  const resolvedCount = decisions.filter((d) => d !== undefined).length
  const allResolved = resolvedCount === clusters.length
  const hasFocus = clusters.some((_, i) => decisions[i] === undefined)

  // 建立 op 下标 → clusterId 映射
  const clusterOf = useRef<Map<number, number>>(new Map())
  clusterOf.current = new Map()
  clusters.forEach((c) => c.opIndices.forEach((i) => clusterOf.current.set(i, c.id)))

  // 焦点簇切换时滚动入视（定位到簇的第一个可见元素）
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(`[data-cluster-first="${focused}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focused])

  // 按顺序渲染，同一 cluster 的连续非 keep ops 合并到一个 diff-cluster span
  const elements: ReactElement[] = []
  let i = 0
  while (i < ops.length) {
    const op = ops[i]
    if (op.op === 'keep') {
      elements.push(<span key={`k-${i}`}>{op.text}</span>)
      i++
      continue
    }

    const clusterId = clusterOf.current.get(i)!
    const decision = decisions[clusterId]
    const isFocused = clusterId === focused
    const state =
      decision === undefined
        ? isFocused
          ? 'focused'
          : ''
        : decision
          ? 'resolved-accept'
          : 'resolved-reject'

    // 收集该 cluster 的所有连续非 keep ops
    const clusterOps: { idx: number; op: DiffOp }[] = []
    while (i < ops.length && ops[i].op !== 'keep') {
      const cid = clusterOf.current.get(i)
      if (cid !== clusterId) break
      clusterOps.push({ idx: i, op: ops[i] })
      i++
    }

    const isFirst = clusterId === 0
    elements.push(
      <span
        key={`c-${clusterId}`}
        className={`diff-cluster ${state}`}
        data-cluster-first={isFirst || clusterId === focused ? String(clusterId) : undefined}
        style={
          // cascade 入场：每簇延迟 40ms，封顶 400ms 防长 diff 拖沓
          clusterId === 0
            ? undefined
            : { animationDelay: `${Math.min(clusterId, 10) * 40}ms` }
        }
        onClick={() => onChangeFocus(clusterId)}
      >
        {clusterOps.map(({ idx, op: cOp }) => {
          if (cOp.op === 'del') {
            // 拒绝 → 原文恢复为正常文本；接受 → 删除文本消失
            if (decision === false)
              return (
                <span key={idx} className="diff-restored">
                  {cOp.text}
                </span>
              )
            if (decision === true) return null
            return (
              <span key={idx} className="diff-del">
                {cOp.text}
              </span>
            )
          }
          if (cOp.op === 'ins') {
            // 拒绝 → 新增文本消失
            if (decision === false) return null
            return (
              <span key={idx} className="diff-ins">
                {cOp.text}
              </span>
            )
          }
          return <span key={idx}>{cOp.text}</span>
        })}
        {isFocused && !allResolved && (
          <span className="diff-actions">
            <button
              className="diff-mini-btn"
              title="接受此簇（Y）"
              onClick={(e) => {
                e.stopPropagation()
                onDecide(clusterId, true)
              }}
            >
              <IconCheck size={10} />
            </button>
            <button
              className="diff-mini-btn reject"
              title="拒绝此簇（N）"
              onClick={(e) => {
                e.stopPropagation()
                onDecide(clusterId, false)
              }}
            >
              <IconX size={10} />
            </button>
          </span>
        )}
      </span>
    )
  }

  return (
    <div className={`diff-view${hasFocus ? ' has-focus' : ''}`}>
      <div className="prose">{elements}</div>
      <div className="diff-footer">
        <span>
          {resolvedCount} / {clusters.length} 处已处理
          {allResolved ? ' · 正在写入…' : ' · Tab 切换 · Y 接受 · N 拒绝'}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={onAcceptAll}>
          <IconCheck size={12} />
          全部接受
          <span className="kbd">Enter</span>
        </button>
        <button className="btn btn-secondary" onClick={onRejectAll}>
          <IconX size={12} />
          全部拒绝
          <span className="kbd">Esc</span>
        </button>
      </div>
    </div>
  )
}

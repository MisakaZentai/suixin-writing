/**
 * 内联 diff 视图（spec F4 / design §5.5「信任的舞台」）。
 * 就地呈现；簇内删在上、增在下；逐处 ✓/✗；焦点环 + 周围内容降透明。
 */
import { useEffect, useRef } from 'react'
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
  const clusters = clusterize(ops)
  const clusterOf = useRef<Map<number, number>>(new Map())
  clusterOf.current = new Map()
  clusters.forEach((c) => c.opIndices.forEach((i) => clusterOf.current.set(i, c.id)))

  const resolvedCount = decisions.filter((d) => d !== undefined).length
  const allResolved = resolvedCount === clusters.length

  // 焦点簇切换时滚动入视
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(
      `[data-cluster-index="${focused}"]`
    )
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focused])

  return (
    <div className="diff-view">
      <div className="prose">
        {ops.map((op, i) => {
          if (op.op === 'keep') return <span key={i}>{op.text}</span>
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
          return (
            <span
              key={i}
              data-cluster-index={clusterId}
              className={`diff-cluster ${state}`}
              onClick={() => onChangeFocus(clusterId)}
            >
              {op.op === 'del' && decision !== true && (
                <span className="diff-del">{op.text}</span>
              )}
              {op.op === 'ins' && decision !== false && (
                <span className="diff-ins">{op.text}</span>
              )}
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
        })}
      </div>
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

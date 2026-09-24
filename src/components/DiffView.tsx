/**
 * 对照确认——让作者放心拍板的地方。
 *
 * 三种看法：
 * - 标注：一段仍是一段，新增加下划线，删除以小号删除线留在原位，可逐处接受 / 拒绝；
 * - 修改后：只看改完的文字（改动过大时的默认视图）；
 * - 对照：原文与修改后上下并排。
 *
 * 操作：接受 ↵ · 改一改 E · 再来一版 R · 放弃 ⌫ · 稍后 Esc。不会自动提交。
 */
import { useEffect, useMemo, type ReactNode } from 'react'
import type { DiffOp, Suggestion } from '../types'
import { clusterIndexOf, clusterize, changeRatio } from '../lib/diff'
import { useUIStore, type DiffState, type DiffViewMode } from '../store/uiStore'
import { useProjectStore } from '../store/projectStore'
import { isStale } from '../lib/doc'
import { regenerate } from '../store/aiActions'
import { SegmentedControl } from './SegmentedControl'
import { IconCheck, IconX } from './icons'
import { ImageFigure } from './ImageFigure'
import { isImageText, parseImage } from '../lib/images'
import { flavorDelta, type FlavorHit } from '../lib/flavor'
import { flavorOptions } from '../lib/flavor/project'

interface Props {
  /** 用于展示的操作流（段内片段已补上前后文） */
  ops: DiffOp[]
  suggestion: Suggestion
  diff: DiffState
}

export function DiffView({ ops, suggestion, diff }: Props) {
  const clusters = useMemo(() => clusterize(ops), [ops])
  const stale = useProjectStore((s) => (s.data ? isStale(s.data, suggestion) : false))
  const ui = () => useUIStore.getState()
  const { decisions, focused, view, whole } = diff
  const decided = decisions.filter((d) => d !== undefined).length
  const candidates = suggestion.candidates ?? [suggestion.proposed]
  const candidateIndex = Math.max(0, candidates.indexOf(suggestion.proposed))
  const ratio = Math.round(changeRatio(suggestion.diff) * 100)
  // AI 味自检：这条修改带进了什么套路、消掉了什么（内置 AI 与 agent 的修改一视同仁）
  const flavor = useMemo(() => {
    const data = useProjectStore.getState().data
    return data ? flavorDelta(suggestion.original, suggestion.proposed, flavorOptions(data)) : null
  }, [suggestion.original, suggestion.proposed])

  // 当前处滚动入视
  useEffect(() => {
    if (view !== 'marked') return
    document
      .querySelector<HTMLElement>(`[data-cluster="${focused}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focused, view])

  const clusterState = (c: number) =>
    decisions[c] === true ? 'accepted' : decisions[c] === false ? 'rejected' : c === focused ? 'focused' : ''

  /* ── 标注视图 ─────────────────────────────────── */
  const renderMarked = () => {
    const out: ReactNode[] = []
    let i = 0
    while (i < ops.length) {
      const c = clusterIndexOf(clusters, i)
      if (c < 0) {
        out.push(<span key={`k${i}`}>{ops[i].text}</span>)
        i++
        continue
      }
      const cluster = clusters[c]
      const state = clusterState(c)
      const parts: ReactNode[] = []
      for (let j = cluster.start; j <= cluster.end; j++) {
        const op = ops[j]
        if (op.op === 'keep') parts.push(<span key={j}>{op.text}</span>)
        else if (op.op === 'del' && state !== 'accepted')
          parts.push(
            <del key={j} className={state === 'rejected' ? 'diff-restored' : 'diff-del'}>
              {op.text}
            </del>
          )
        else if (op.op === 'ins' && state !== 'rejected')
          parts.push(
            <ins key={j} className={state === 'accepted' ? 'diff-ins accepted' : 'diff-ins'}>
              {op.text}
            </ins>
          )
      }
      out.push(
        <span
          key={`c${c}`}
          data-cluster={c}
          className={`diff-cluster ${state}`}
          onClick={() => ui().focusCluster(c)}
        >
          {parts}
          {c === focused && !whole && (
            <span className="diff-actions" onClick={(e) => e.stopPropagation()}>
              <button
                className={`diff-mini-btn${decisions[c] === true ? ' on' : ''}`}
                title="接受这一处（Y）"
                aria-label="接受这一处"
                onClick={() => ui().setDecision(c, true)}
              >
                <IconCheck size={10} />
              </button>
              <button
                className={`diff-mini-btn reject${decisions[c] === false ? ' on' : ''}`}
                title="拒绝这一处（N）"
                aria-label="拒绝这一处"
                onClick={() => ui().setDecision(c, false)}
              >
                <IconX size={10} />
              </button>
            </span>
          )}
        </span>
      )
      i = cluster.end + 1
    }
    return out
  }

  /* ── 修改后 / 对照 ───────────────────────────── */
  const renderSide = (side: 'old' | 'new') =>
    ops.map((op, i) => {
      if (op.op === 'keep') return <span key={i}>{op.text}</span>
      if (side === 'new' && op.op === 'ins') return <ins key={i} className="diff-ins quiet">{op.text}</ins>
      if (side === 'old' && op.op === 'del') return <del key={i} className="diff-del quiet">{op.text}</del>
      return null
    })

  /** 修改后的全文里有图片（如 agent 插的图）：按段画出来，图片显示成图 */
  const newText = ops.filter((op) => op.op !== 'del').map((op) => op.text).join('')
  const newParts = newText.split(/\n{2,}/)
  const withImages = newParts.some((p) => isImageText(p))
  const renderRich = () =>
    newParts.map((p, i) => {
      const img = parseImage(p)
      return img ? (
        <ImageFigure key={i} src={img.src} caption={img.caption} />
      ) : (
        <p key={i} className="diff-rich-para">
          {p}
        </p>
      )
    })

  const summary = stale
    ? '原文在这之后被改动过，这条修改已过期'
    : whole
      ? diff.insert
        ? 'AI 新写的内容'
        : `改动较大（约 ${ratio}%），建议整体比较后决定`
      : `${clusters.length} 处改动${decided ? ` · 已处理 ${decided}` : ''}`

  const acceptLabel = whole || decided === 0 ? '接受' : decided === clusters.length ? '完成' : '接受其余'

  const viewItems: { value: DiffViewMode; label: string }[] = [
    ...(whole ? [] : [{ value: 'marked' as const, label: '标注' }]),
    { value: 'result', label: '修改后' },
    ...(diff.insert ? [] : [{ value: 'compare' as const, label: '对照' }]),
  ]

  return (
    <div className={`diff-view${stale ? ' stale' : ''}`} onClick={(e) => e.stopPropagation()}>
      {view === 'compare' ? (
        <div className="diff-compare">
          <div className="diff-compare-col">
            <div className="diff-compare-label">原文</div>
            <div className="prose">{renderSide('old')}</div>
          </div>
          <div className="diff-compare-col">
            <div className="diff-compare-label">修改后</div>
            <div className="prose">{renderSide('new')}</div>
          </div>
        </div>
      ) : (
        <div className="prose">
          {view === 'marked' ? renderMarked() : withImages ? renderRich() : renderSide('new')}
        </div>
      )}

      {suggestion.author ? (
        <div className="diff-instruction">
          <span className="agent-badge">{suggestion.author.name}</span>
          {suggestion.why ? ` 的理由：${suggestion.why}` : ' 提出的修改'}
        </div>
      ) : (
        suggestion.instruction &&
        suggestion.task !== 'rewrite' && <div className="diff-instruction">要求：{suggestion.instruction}</div>
      )}

      {flavor && <FlavorLine delta={flavor} original={suggestion.original} insert={diff.insert} />}

      <div className="diff-bar">
        {viewItems.length > 1 && (
          <SegmentedControl<DiffViewMode>
            value={view}
            items={viewItems}
            onChange={(v) => ui().setDiffView(v)}
            ariaLabel="查看方式"
          />
        )}
        <span className={`diff-summary${stale ? ' stale' : ''}`}>{summary}</span>
        <span className="diff-bar-spacer" />
        {candidates.length > 1 && (
          <span className="diff-candidates" aria-label="候选">
            <button className="icon-btn" onClick={() => ui().switchCandidate(-1)} title="上一个候选（←）">
              ‹
            </button>
            {candidateIndex + 1} / {candidates.length}
            <button className="icon-btn" onClick={() => ui().switchCandidate(1)} title="下一个候选（→）">
              ›
            </button>
          </span>
        )}
        {!suggestion.author && (
          <button className="btn btn-plain" onClick={() => void regenerate(suggestion.id)} title="再来一版（R）">
            {stale ? '重新生成' : '再来一版'}
          </button>
        )}
        {!stale && (
          <button className="btn btn-plain" onClick={() => ui().acceptAndEdit()} title="接受后在此基础上继续改（E）">
            改一改
          </button>
        )}
        <button className="btn btn-plain" onClick={() => ui().rejectDiff()} title="放弃这条修改（Backspace）">
          放弃
        </button>
        {!stale && (
          <button className="btn btn-primary" onClick={() => void ui().acceptDiff()} title="接受（Enter）">
            <IconCheck size={12} />
            {acceptLabel}
            <span className="kbd on-accent">↵</span>
          </button>
        )}
      </div>
      <div className="diff-hint">
        {!whole && view === 'marked' && !stale && 'Tab 换一处 · Y 接受这处 · N 拒绝这处 · '}
        Esc 稍后再说（保留为待确认）
      </div>
    </div>
  )
}

const names = (hits: FlavorHit[]) => [...new Set(hits.map((h) => h.name))].join('、')

/** 确认条上方的一行：AI 味前后对比；改写带进了新套路时标红，提示再来一版或改一改 */
function FlavorLine({ delta, original, insert }: { delta: ReturnType<typeof flavorDelta>; original: string; insert: boolean }) {
  const { before, after, added, removed } = delta
  // 改了说法却还是同一个套路（"不是…而是"换成"不是…，是"）
  const reshaped = delta.kept.filter((h) => !original.includes(h.text))
  // 没有套路的增减时，只有前后两个指数都算得出且不同才值得显示（太短的片段算不出指数）
  const changed = insert ? !!after : before != null && after != null && before !== after
  if (!added.length && !removed.length && !reshaped.length && !changed) return null
  const fmt = (x: number | null) => (x == null ? '—' : String(x))
  return (
    <div className={`diff-flavor${added.length || reshaped.length ? ' worse' : ''}`} aria-label="AI 味">
      <span className="diff-flavor-index">AI 味 {insert ? fmt(after) : `${fmt(before)} → ${fmt(after)}`}</span>
      {removed.length > 0 && <span className="diff-flavor-removed">去掉了{names(removed)}</span>}
      {reshaped.length > 0 && (
        <span className="diff-flavor-added">
          换了说法，仍是{names(reshaped)}：{reshaped.map((h) => `「${h.text.length > 10 ? h.text.slice(0, 10) + '…' : h.text}」`).join('')}
        </span>
      )}
      {added.length > 0 && (
        <span className="diff-flavor-added" title={added.map((h) => `「${h.text}」${h.name}`).join('\n')}>
          新增{added.map((h) => `「${h.text.length > 10 ? h.text.slice(0, 10) + '…' : h.text}」`).join('')}（{names(added)}）
        </span>
      )}
    </div>
  )
}

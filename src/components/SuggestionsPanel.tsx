/**
 * 待办面板：交给 Agent 的任务，未确认的 AI / agent 修改与检查建议。
 * agent 一次提交的多条建议归为一组（变更集），可以整组接受或放弃。
 */
import type { AgentTask, ProjectData, Suggestion } from '../types'
import { isActive } from '../lib/tasks'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { getBlock, isStale } from '../lib/doc'
import { IconX } from './icons'
import { adoptNote } from '../store/aiActions'

interface Group {
  key: string
  author?: string
  changeset?: string
  items: Suggestion[]
}

function groupOf(pending: Suggestion[]): Group[] {
  const groups: Group[] = []
  const byChangeset = new Map<string, Group>()
  for (const s of pending) {
    if (s.changeset) {
      let g = byChangeset.get(s.changeset)
      if (!g) {
        g = { key: s.changeset, author: s.author?.name, changeset: s.changeset, items: [] }
        byChangeset.set(s.changeset, g)
        groups.push(g)
      }
      g.items.push(s)
    } else {
      groups.push({ key: s.id, items: [s] })
    }
  }
  return groups
}

export function SuggestionsPanel() {
  const data = useProjectStore((s) => s.data)
  const ui = () => useUIStore.getState()
  if (!data) return null
  const pending = data.suggestions.filter((s) => s.state === 'pending')
  const groups = groupOf(pending)
  // 作者取消的不再显示；做完的留着，看过再移除
  const tasks = (data.tasks ?? []).filter((t) => t.state !== 'cancelled')
  const count = pending.length + tasks.filter(isActive).length

  return (
    <aside className="suggestions-panel" aria-label="待办">
      <div className="suggestions-header">
        <span>待办 {count > 0 && `(${count})`}</span>
        <button className="icon-btn" onClick={() => ui().setSuggestionsOpen(false)} title="关闭" aria-label="关闭">
          <IconX />
        </button>
      </div>
      <div className="suggestions-list">
        {tasks.length > 0 && (
          <section className="tasks-section" aria-label="交给 Agent 的任务">
            <div className="tasks-section-title">交给 Agent 的任务</div>
            {tasks.map((t) => (
              <TaskCard key={t.id} t={t} data={data} />
            ))}
          </section>
        )}
        {pending.length === 0 && tasks.length === 0 ? (
          <div className="suggestions-empty">
            没有待处理的事项。
            <br />
            AI 与 agent 的修改确认后才会写入正文。
          </div>
        ) : (
          groups.map((g) =>
            g.changeset && g.items.length > 1 ? (
              <ChangesetGroup key={g.key} group={g} data={data} />
            ) : (
              <SuggestionCard key={g.key} s={g.items[0]} data={data} />
            )
          )
        )}
      </div>
    </aside>
  )
}

function TaskCard({ t, data }: { t: AgentTask; data: ProjectData }) {
  const ui = () => useUIStore.getState()
  const anchor = t.target.blockIds[0] ?? t.target.insertAfter ?? undefined
  const stateText =
    t.state === 'open' ? '等待 Agent 接手' : t.state === 'claimed' ? `${t.claimedBy} 处理中…` : `${t.claimedBy} 已完成`
  const quote = t.quote.length > 80 ? `${t.quote.slice(0, 80)}…` : t.quote
  return (
    <div className="suggestion-card" aria-label={`任务：${t.instruction}`}>
      <span className={`task-state${t.state === 'done' ? ' done' : ''}`}>{stateText}</span>
      <span className="instruction">要求：{t.instruction}</span>
      {t.summary && <span className="instruction">说明：{t.summary}</span>}
      <button
        className="text"
        title="定位到这一处"
        disabled={!anchor || !getBlock(data, anchor)}
        onClick={() => {
          if (!anchor) return
          ui().requestLocate(anchor)
          ui().setActive(anchor)
        }}
      >
        {quote || '（整篇）'}
      </button>
      <div className="actions">
        {isActive(t) ? (
          <button className="btn btn-secondary" onClick={() => useProjectStore.getState().cancelTask(t.id)}>
            取消任务
          </button>
        ) : (
          <button className="btn btn-secondary" onClick={() => useProjectStore.getState().removeTask(t.id)}>
            知道了
          </button>
        )}
      </div>
    </div>
  )
}

function ChangesetGroup({ group, data }: { group: Group; data: ProjectData }) {
  const edits = group.items.filter((s) => s.kind === 'ai_diff').length
  const notes = group.items.length - edits
  const ui = () => useUIStore.getState()
  return (
    <section className="changeset" aria-label={`${group.author ?? 'Agent'} 的一组修改`}>
      <div className="changeset-head">
        <span className="agent-badge">{group.author ?? 'Agent'}</span>
        <span className="changeset-count">
          {edits > 0 && `${edits} 处修改`}
          {edits > 0 && notes > 0 && ' · '}
          {notes > 0 && `${notes} 条意见`}
        </span>
      </div>
      <div className="actions">
        {edits > 0 && (
          <button
            className="btn btn-primary"
            onClick={() => {
              const { applied, stale } = useProjectStore.getState().acceptChangeset(group.changeset!)
              ui().pushToast({
                kind: stale ? 'info' : 'success',
                text: stale ? `已接受 ${applied} 处，${stale} 处原文已变、已跳过` : `已接受 ${applied} 处修改`,
                actionLabel: '撤销',
                onAction: () => useProjectStore.getState().undo(),
                duration: 6000,
              })
            }}
          >
            整组接受
          </button>
        )}
        <button
          className="btn btn-secondary"
          onClick={() => useProjectStore.getState().rejectChangeset(group.changeset!)}
        >
          整组放弃
        </button>
      </div>
      {group.items.map((s) => (
        <SuggestionCard key={s.id} s={s} data={data} nested />
      ))}
    </section>
  )
}

function SuggestionCard({ s, data, nested }: { s: Suggestion; data: ProjectData; nested?: boolean }) {
  const ui = () => useUIStore.getState()
  const anchor = s.target.blockIds[0] ?? s.target.insertAfter ?? undefined
  const stale = s.kind === 'ai_diff' && isStale(data, s)
  const b = anchor ? getBlock(data, anchor) : undefined
  const preview = !b ? '（位置已不存在）' : b.text.length > 80 ? `${b.text.slice(0, 80)}…` : b.text
  const who = s.author?.name
  const label =
    s.kind === 'note' ? '检查建议' : !s.target.blockIds.length ? '新写的内容' : stale ? '修改 · 已过期' : '修改'

  return (
    <div className={`suggestion-card${nested ? ' nested' : ''}`}>
      <span className={`kind${s.kind === 'note' ? ' note' : ''}`}>
        {!nested && who && <span className="agent-badge">{who}</span>}
        {label}
      </span>
      {s.issue && <span className="instruction">问题：{s.issue}</span>}
      {s.why && <span className="instruction">理由：{s.why}</span>}
      {!s.why && s.instruction && (
        <span className="instruction">
          {s.kind === 'note' ? '建议：' : '要求：'}
          {s.instruction}
        </span>
      )}
      <button
        className="text"
        title="定位到这一段"
        onClick={() => {
          if (!anchor) return
          ui().requestLocate(anchor)
          ui().setActive(anchor)
        }}
      >
        {preview}
      </button>
      <div className="actions">
        {s.kind === 'ai_diff' ? (
          <button
            className="btn btn-primary"
            disabled={stale}
            onClick={() => {
              if (anchor) ui().requestLocate(anchor)
              ui().openDiff(s.id)
            }}
          >
            查看修改
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => adoptNote(s.id)}>
            按建议修改
          </button>
        )}
        <button className="btn btn-secondary" onClick={() => useProjectStore.getState().dismissSuggestion(s.id)}>
          忽略
        </button>
      </div>
    </div>
  )
}

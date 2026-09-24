/**
 * 块卡片 — 应用的心脏（design §5.3）。
 * 三态流转（阅读 ↔ 编辑 ↔ diff）用同一容器连续形变表达；
 * 浮动操作条 / 提意见 / 打字机 / 内联 diff 全部就地呈现。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DisplayBlock } from '../types'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useHeightMorph } from '../hooks/useHeightMorph'
import { DiffView } from './DiffView'
import { StreamView } from './StreamView'
import {
  IconComment,
  IconEdit,
  IconHistory,
  IconSparkles,
  IconX,
} from './icons'
import { flattenOutline } from '../lib/project'

interface Props {
  block: DisplayBlock
  prevBlock: DisplayBlock | null
  active: boolean
}

const SOURCE_LABEL: Record<string, string> = {
  import: '导入',
  manual: '手动',
  ai_rewrite: 'AI 重写',
  ai_revise: 'AI 意见',
  merge: '合并',
  split: '拆分',
}

export function BlockCard({ block, prevBlock, active }: Props) {
  const data = useProjectStore((s) => s.data)
  const ui = useUIStore()
  const editing = ui.editing?.key === block.key ? ui.editing : null
  const opinion = ui.opinion?.key === block.key ? ui.opinion : null
  const stream = ui.stream?.key === block.key ? ui.stream : null

  const pendingSuggestion = data?.suggestions.find(
    (s) =>
      s.state === 'pending' &&
      s.kind === 'ai_diff' &&
      block.blockIds.includes(s.blockId)
  )
  const diffSuggestion =
    ui.diff && data
      ? data.suggestions.find((s) => s.id === ui.diff!.suggestionId)
      : undefined
  const showDiff =
    ui.diff != null &&
    diffSuggestion != null &&
    block.blockIds.includes(diffSuggestion.blockId)

  const mode = editing
    ? 'edit'
    : showDiff
      ? 'diff'
      : stream
        ? 'stream'
        : opinion
          ? 'opinion'
          : 'read'
  const { ref, ghost } = useHeightMorph<HTMLDivElement>(mode)

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const versionPanelOpen = ui.versionPanelKey === block.key
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const opinionRef = useRef<HTMLTextAreaElement>(null)

  /* 进入编辑/意见态后聚焦 */
  useEffect(() => {
    if (editing) {
      const t = window.setTimeout(() => {
        textareaRef.current?.focus()
        const len = textareaRef.current?.value.length ?? 0
        textareaRef.current?.setSelectionRange(len, len)
      }, 180)
      return () => window.clearTimeout(t)
    }
    if (opinion) {
      const t = window.setTimeout(() => opinionRef.current?.focus(), 280)
      return () => window.clearTimeout(t)
    }
  }, [editing, opinion])

  /* textarea 自适应高度 */
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [editing?.draft])
  useLayoutEffect(() => {
    const el = opinionRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(160, el.scrollHeight)}px`
  }, [opinion?.draft])

  /* 关闭菜单 */
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [menu])

  /* diff 全部处理完 → 落盘 */
  const allResolved =
    ui.diff != null &&
    ui.diff.decisions.every((d) => d !== undefined)
  useEffect(() => {
    if (!showDiff || !allResolved || !ui.diff) return
    const t = window.setTimeout(() => {
      useProjectStore
        .getState()
        .applySuggestionDecision(
          ui.diff!.suggestionId,
          ui.diff!.decisions.map((d) => d === true)
        )
      useUIStore.getState().closeDiff()
      useUIStore
        .getState()
        .pushToast({ kind: 'success', text: '已按确认结果写入版本历史' })
    }, 420)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allResolved, showDiff])

  if (!data) return null

  const classes = [
    'block',
    mode,
    active ? 'active' : '',
    block.status === 'pending' ? 'pending' : '',
    mode !== 'read' ? 'busy' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const renderMode = (m: string, isGhost: boolean) => {
    switch (m) {
      case 'edit':
        return (
          <div style={{ position: 'relative' }}>
            <textarea
              ref={isGhost ? undefined : textareaRef}
              className="block-edit"
              value={editing?.draft ?? block.text}
              readOnly={isGhost}
              onChange={(e) => ui.updateEditDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  ui.cancelEdit()
                }
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  ui.confirmEdit()
                }
              }}
            />
            {!isGhost && (
              <span className="edit-hint">Esc 取消 · Ctrl+↵ 确认</span>
            )}
          </div>
        )
      case 'opinion':
        return (
          <div>
            <p className="prose block-text">{block.text}</p>
            <div className="opinion-box">
              <textarea
                ref={isGhost ? undefined : opinionRef}
                className="opinion-input"
                placeholder="对这段有什么意见？例如：压到 50 字以内"
                value={opinion?.draft ?? ''}
                readOnly={isGhost}
                onChange={(e) => ui.updateOpinionDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    ui.cancelOpinion()
                  }
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    void ui.startRevise(block.key)
                  }
                }}
              />
              <div className="opinion-footer">
                <span>AI 将按意见产出 diff，逐处确认后生效</span>
                <button
                  className="btn btn-primary"
                  onClick={() => void ui.startRevise(block.key)}
                >
                  提交
                  <span className="kbd" style={{ color: 'rgba(255,255,255,.75)' }}>
                    Ctrl+↵
                  </span>
                </button>
              </div>
            </div>
          </div>
        )
      case 'stream':
        return stream ? (
          <StreamView tw={stream.tw} onAbort={() => ui.abortAI()} />
        ) : null
      case 'diff':
        return (
          <DiffView
            ops={diffSuggestion?.diff ?? []}
            decisions={ui.diff?.decisions ?? []}
            focused={ui.diff?.focused ?? 0}
            onChangeFocus={(i) => ui.focusCluster(i)}
            onDecide={(i, accepted) => ui.setDecision(i, accepted)}
            onAcceptAll={() => ui.decideAll(true)}
            onRejectAll={() => ui.decideAll(false)}
          />
        )
      default:
        return (
          <div>
            <p className="prose block-text">{block.text}</p>
            {pendingSuggestion && !ghost && (
              <span className="pending-inline">
                <IconSparkles size={12} />
                <button
                  style={{ color: 'var(--warning)', fontWeight: 600 }}
                  onClick={() => ui.openDiff(pendingSuggestion.id)}
                >
                  AI 已产出修改，点击查看 diff
                </button>
              </span>
            )}
          </div>
        )
    }
  }

  return (
    <div
      ref={ref}
      className={classes}
      data-block-key={block.key}
      onMouseDown={() => {
        if (ui.activeKey !== block.key) ui.setActive(block.key)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        ui.setActive(block.key)
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <span className="block-anchor" />
      {block.status === 'dirty' && <span className="dirty-dot" title="未保存的修改" />}

      {active && mode === 'read' && (
        <div className="floating-toolbar">
          <button
            className="tool-btn"
            onClick={() => ui.beginEdit(block.key, block.text)}
            title="编辑（E）"
          >
            <IconEdit />
            编辑
            <span className="kbd">E</span>
          </button>
          <button
            className="tool-btn"
            onClick={() => ui.beginOpinion(block.key)}
            title="提意见（R）"
          >
            <IconComment />
            提意见
            <span className="kbd">R</span>
          </button>
          <button
            className="tool-btn"
            onClick={() => void ui.startRewrite(block.key)}
            title="重写（T）"
          >
            <IconSparkles />
            重写
            <span className="kbd">T</span>
          </button>
        </div>
      )}

      {active && mode === 'read' && block.versions.length > 1 && (
        <button
          className="icon-btn"
          style={{ position: 'absolute', top: -2, right: -8, zIndex: 10 }}
          title="版本历史"
          onClick={() =>
            ui.setVersionPanelKey(versionPanelOpen ? null : block.key)
          }
        >
          <IconHistory size={12} />
        </button>
      )}

      {active && (mode === 'read' || mode === 'edit' || mode === 'opinion') && (
        <div className="block-meta-line">
          <span>{block.text.length} 字</span>
          {block.outlinePath.length > 0 && (
            <span>· {block.outlinePath.map((n) => n.title).join(' / ')}</span>
          )}
          {block.versions.length > 1 && (
            <span>· {block.versions.length} 个版本</span>
          )}
        </div>
      )}

      <div className="morph">
        {renderMode(mode, false)}
        {ghost && (
          <div className="morph-layer leaving" style={{ opacity: 0 }}>
            {renderMode(ghost.from, true)}
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {menu && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              ui.beginEdit(block.key, block.text)
              setMenu(null)
            }}
          >
            编辑
            <span className="kbd">E</span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              ui.beginOpinion(block.key)
              setMenu(null)
            }}
          >
            提意见
            <span className="kbd">R</span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              void ui.startRewrite(block.key)
              setMenu(null)
            }}
          >
            重写
            <span className="kbd">T</span>
          </button>
          <div className="context-menu-sep" />
          {prevBlock && (
            <button
              className="context-menu-item"
              onClick={() => {
                const ids = useProjectStore
                  .getState()
                  .mergeWithPrevious(block.key, prevBlock.key)
                setMenu(null)
                if (ids.length) {
                  useUIStore.getState().setActive(`s:${ids[0]}`)
                  useUIStore
                    .getState()
                    .pushToast({ kind: 'success', text: '已合并相邻块' })
                }
              }}
            >
              与前一块合并
            </button>
          )}
          <button
            className="context-menu-item"
            onClick={() => {
              const ids = useProjectStore.getState().splitAt(block.key, null)
              setMenu(null)
              if (ids.length) {
                useUIStore.getState().setActive(`s:${ids[0]}`)
                useUIStore
                  .getState()
                  .pushToast({ kind: 'success', text: '已按句子边界拆分' })
              }
            }}
          >
            拆分（句中点）
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              setPickerOpen(true)
              setMenu(null)
            }}
          >
            挂靠到大纲节点…
          </button>
          <div className="context-menu-sep" />
          <button
            className="context-menu-item"
            onClick={() => {
              ui.setVersionPanelKey(versionPanelOpen ? null : block.key)
              setMenu(null)
            }}
          >
            版本历史
            <span className="kbd">{block.versions.length} 版</span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              void navigator.clipboard.writeText(block.text)
              setMenu(null)
              useUIStore
                .getState()
                .pushToast({ kind: 'info', text: '已复制块文本' })
            }}
          >
            复制文本
          </button>
        </div>
      )}

      {/* 节点选择器 */}
      {pickerOpen && (
        <NodePicker
          onPick={(nodeId) => {
            useProjectStore.getState().attachToNode(block.key, nodeId)
            setPickerOpen(false)
            useUIStore.getState().pushToast({
              kind: 'success',
              text: nodeId ? '已挂靠到节点' : '已取消挂靠',
            })
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* 版本历史 */}
      {versionPanelOpen && (
        <div
          className="popover"
          style={{ position: 'absolute', top: 8, right: 0, zIndex: 60 }}
        >
          <div className="popover-title">版本历史（可回退）</div>
          {block.versions.map((v, i) => (
            <button
              key={v.v}
              className={`version-item${i === block.versions.length - 1 ? ' current' : ''}`}
              onClick={() => {
                const ids = useProjectStore.getState().rollback(block.key, i)
                useUIStore.getState().setVersionPanelKey(null)
                if (ids.length) {
                  useUIStore.getState().setActive(`s:${ids[0]}`)
                  useUIStore.getState().pushToast({
                    kind: 'success',
                    text: `已回退到版本 v${v.v}`,
                  })
                }
              }}
            >
              <span className="v-tag">v{v.v}</span>
              <span className="v-text">{v.text || '（空）'}</span>
              <span className="v-source">{SOURCE_LABEL[v.source] ?? v.source}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 挂靠节点选择器 */
function NodePicker({
  onPick,
  onClose,
}: {
  onPick: (nodeId: string | null) => void
  onClose: () => void
}) {
  const data = useProjectStore((s) => s.data)
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [onClose])
  const flat = data ? flattenOutline(data.outline) : []
  return (
    <div
      className="popover"
      style={{ position: 'absolute', top: 8, left: 0, zIndex: 70 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="popover-title">挂靠到大纲节点</div>
      {flat.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: 8 }}>
          尚未建立大纲
        </div>
      )}
      {flat.map(({ node, path }) => (
        <button
          key={node.id}
          className="context-menu-item"
          style={{ paddingLeft: 8 + (path.length - 1) * 12 }}
          onClick={() => onPick(node.id)}
        >
          {node.title}
        </button>
      ))}
      <div className="context-menu-sep" />
      <button className="context-menu-item" onClick={() => onPick(null)}>
        <IconX size={12} />
        取消挂靠（未关联节点）
      </button>
    </div>
  )
}

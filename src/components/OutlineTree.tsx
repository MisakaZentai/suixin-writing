/**
 * 大纲：由正文里的标题实时生成，没有第二份数据。
 * - 单击定位整节，双击改名（即改标题）；
 * - 拖拽节点 = 移动整节（含子节与正文）：落在上沿 / 下沿插到前后，落在中间成为子节；
 * - 右键：升降级、加小节、AI 扩写 / 精简 / 检查本节、删除标题。
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevron, IconPlus, IconSparkles } from './icons'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { buildOutline, getBlock, headingPaths, indexOfBlock, sectionBodyIds, sectionEnd } from '../lib/doc'
import type { OutlineNode } from '../types'
import { checkSection, expandSection, inferSections, runScope } from '../store/aiActions'
import { MenuItem, clampMenu } from './BlockCard'

type DropPos = 'before' | 'after' | 'inside'

export function OutlineTree() {
  const blocks = useProjectStore((s) => s.data?.blocks)
  const activeId = useUIStore((s) => s.activeId)
  const outline = useMemo(() => (blocks ? buildOutline(blocks) : []), [blocks])
  const paths = useMemo(() => (blocks ? headingPaths(blocks) : null), [blocks])
  /** 当前选中块所在的最近标题（大纲反向定位） */
  const activeHeadingId = useMemo(() => {
    if (!blocks || !activeId || !paths) return null
    const block = blocks.find((b) => b.id === activeId)
    if (!block) return null
    if (block.type === 'heading') return block.id
    return (paths.get(activeId) ?? []).slice(-1)[0]?.id ?? null
  }, [blocks, activeId, paths])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [breatheId, setBreatheId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; pos: DropPos } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; node: OutlineNode } | null>(null)

  // 选中块 → 所在标题展开并闪一下
  useEffect(() => {
    if (!activeHeadingId || !paths) return
    const path = paths.get(activeHeadingId) ?? []
    setCollapsed((prev) => {
      if (!path.some((h) => prev.has(h.id))) return prev
      const next = new Set(prev)
      path.forEach((h) => next.delete(h.id))
      return next
    })
    setBreatheId(activeHeadingId)
    const t = window.setTimeout(() => setBreatheId(null), 900)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHeadingId])

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest('.context-menu')) return
      setMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  if (!blocks) return null
  const store = () => useProjectStore.getState()
  const ui = () => useUIStore.getState()
  const undoToast = (text: string) =>
    ui().pushToast({ kind: 'info', text, actionLabel: '撤销', onAction: () => store().undo(), duration: 5000 })

  const commitRename = (id: string) => {
    setEditingId(null)
    if (draft.trim()) store().editBlock(id, draft.trim())
  }

  const locate = (id: string) => {
    ui().requestLocate(id)
    ui().setActive(id)
  }

  /** 目标是否在被拖动的那一节里（不能把一节拖进自己） */
  const insideDragged = (targetId: string): boolean => {
    const d = store().data
    if (!d || !dragId) return false
    const i = indexOfBlock(d, dragId)
    const t = indexOfBlock(d, targetId)
    return t >= i && t < sectionEnd(d.blocks, i)
  }

  /** 新增小节：插在该节末尾，层级 +1 */
  const addChild = (node: OutlineNode) => {
    const d = store().data
    if (!d) return
    const end = sectionEnd(d.blocks, indexOfBlock(d, node.id))
    const afterId = d.blocks[end - 1]?.id ?? node.id
    const id = store().insertHeadingAfter(afterId, Math.min(6, node.level + 1), '新小节')
    if (id) {
      setEditingId(id)
      setDraft('新小节')
    }
  }

  /** 在这一节后面加同级章节 */
  const addSibling = (node: OutlineNode) => {
    const d = store().data
    if (!d) return
    const end = sectionEnd(d.blocks, indexOfBlock(d, node.id))
    const id = store().insertHeadingAfter(d.blocks[end - 1]?.id ?? node.id, node.level, '新章节')
    if (id) {
      setEditingId(id)
      setDraft('新章节')
    }
  }

  const addRoot = () => {
    const d = store().data
    if (!d) return
    const level = outline[0]?.level ?? 2
    const id = store().insertHeadingAfter(d.blocks[d.blocks.length - 1]?.id ?? null, level, '新章节')
    if (id) {
      setEditingId(id)
      setDraft('新章节')
      ui().requestLocate(id)
    }
  }

  const condense = (node: OutlineNode) => {
    const d = store().data
    const heading = d && getBlock(d, node.id)
    if (!d || !heading) return
    const body = sectionBodyIds(d.blocks, node.id)
    if (!body.length) {
      ui().pushToast({ kind: 'info', text: '这一节还没有正文' })
      return
    }
    locate(node.id)
    void runScope(
      { kind: 'section', blockIds: body, headingId: node.id, anchorId: node.id, label: `本节「${heading.text}」` },
      '精简这一节：删去重复与冗余，保留要点与关键细节，篇幅压缩到原来的一半到三分之二。'
    )
  }

  const renderNode = (node: OutlineNode, depth: number) => {
    const hasChildren = node.children.length > 0
    const open = !collapsed.has(node.id)
    const dropHere = drop?.id === node.id ? ` drop-${drop.pos}` : ''
    return (
      <div key={node.id}>
        <div
          className={`outline-row${breatheId === node.id ? ' outline-breathe' : ''}${
            activeHeadingId === node.id ? ' selected' : ''
          }${dragId === node.id ? ' dragging' : ''}${dropHere}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          data-outline-id={node.id}
          draggable={editingId !== node.id}
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-suixin-section', node.id)
            e.dataTransfer.effectAllowed = 'move'
            setDragId(node.id)
          }}
          onDragOver={(e) => {
            if (!dragId || dragId === node.id || insideDragged(node.id)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            const r = e.currentTarget.getBoundingClientRect()
            const y = (e.clientY - r.top) / r.height
            const pos: DropPos = y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside'
            if (drop?.id !== node.id || drop.pos !== pos) setDrop({ id: node.id, pos })
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null)
          }}
          onDrop={(e) => {
            e.preventDefault()
            if (dragId && drop) {
              const moved = store().moveSection(dragId, drop.id, drop.pos)
              if (moved) undoToast('整节已移动')
              else ui().pushToast({ kind: 'info', text: '移到这里会超过六级标题，已取消' })
            }
            setDragId(null)
            setDrop(null)
          }}
          onDragEnd={() => {
            setDragId(null)
            setDrop(null)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, node })
          }}
        >
          <button
            className={`chevron${open ? ' open' : ''}${hasChildren ? '' : ' leaf'}`}
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev)
                if (next.has(node.id)) next.delete(node.id)
                else next.add(node.id)
                return next
              })
            }
            aria-label={open ? '折叠' : '展开'}
            tabIndex={-1}
          >
            <IconChevron size={12} />
          </button>
          {editingId === node.id ? (
            <input
              className="outline-title-input"
              value={draft}
              autoFocus
              onFocus={(e) => e.target.select()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commitRename(node.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(node.id)
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setEditingId(null)
                }
              }}
            />
          ) : (
            <span
              className="outline-title"
              onClick={() => locate(node.id)}
              onDoubleClick={() => {
                setEditingId(node.id)
                setDraft(node.title)
              }}
              title={`${node.title}（单击定位 · 双击改名 · 拖动调整位置 · 右键更多）`}
            >
              {node.title || '（无标题）'}
            </span>
          )}
          <span className="outline-actions">
            <button className="icon-btn" title="AI 扩写这一节" onClick={() => void expandSection(node.id)}>
              <IconSparkles size={12} />
            </button>
            <button className="icon-btn" title="新增小节" onClick={() => addChild(node)}>
              <IconPlus size={12} />
            </button>
          </span>
        </div>
        {hasChildren && open && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  const run = (fn: () => void) => () => {
    setMenu(null)
    fn()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div className="sidebar-header">
        <span>大纲</span>
        <button className="icon-btn" title="新增章节（加在文末）" onClick={addRoot}>
          <IconPlus />
        </button>
      </div>
      <div className="sidebar-scroll">
        {outline.length === 0 ? (
          <div className="outline-empty">
            正文里还没有标题
            <br />
            {blocks.some((b) => b.type === 'paragraph' && b.text.trim()) ? (
              <button
                className="btn btn-plain"
                style={{ marginTop: 8, color: 'var(--accent)' }}
                onClick={() => void inferSections()}
              >
                <IconSparkles size={12} />
                让 AI 划分章节
              </button>
            ) : (
              <span>在段落开头输入 “## ” 即可创建标题</span>
            )}
          </div>
        ) : (
          outline.map((n) => renderNode(n, 0))
        )}
      </div>

      {menu &&
        createPortal(
          <div
            className="context-menu"
            style={clampMenu(menu.x, menu.y)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <MenuItem
              label="改名"
              onClick={run(() => {
                setEditingId(menu.node.id)
                setDraft(menu.node.title)
              })}
            />
            <MenuItem
              label="升一级（整节）"
              onClick={run(() => {
                if (!store().shiftSectionLevel(menu.node.id, -1))
                  ui().pushToast({ kind: 'info', text: '已经是最高一级' })
              })}
            />
            <MenuItem
              label="降一级（整节）"
              onClick={run(() => {
                if (!store().shiftSectionLevel(menu.node.id, 1))
                  ui().pushToast({ kind: 'info', text: '已经是最低一级' })
              })}
            />
            <MenuItem label="在后面加同级章节" onClick={run(() => addSibling(menu.node))} />
            <MenuItem label="加小节" onClick={run(() => addChild(menu.node))} />
            <div className="context-menu-sep" />
            <MenuItem label="AI 扩写本节" onClick={run(() => void expandSection(menu.node.id))} />
            <MenuItem label="AI 精简本节" onClick={run(() => condense(menu.node))} />
            <MenuItem
              label="检查本节"
              onClick={run(() => {
                locate(menu.node.id)
                void checkSection(menu.node.id)
              })}
            />
            <div className="context-menu-sep" />
            <MenuItem
              label="删除标题（正文并入上一节）"
              danger
              onClick={run(() => {
                store().removeBlock(menu.node.id)
                undoToast('标题已删除，正文并入上一节')
              })}
            />
          </div>,
          document.body
        )}
    </div>
  )
}

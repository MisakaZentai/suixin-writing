/** 大纲树：节点编辑 + 双向定位 + 节点级 AI（扩写 / 对齐检查）（spec F5） */
import { useEffect, useMemo, useState } from 'react'
import {
  IconChevron,
  IconPlus,
  IconSparkles,
  IconTrash,
} from './icons'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { flattenOutline, getDisplayBlocks } from '../lib/project'
import type { OutlineNode, OutlineNodeWithPath } from '../types'

interface Props {
  activeOutlineNodeId: string | null
}

export function OutlineTree({ activeOutlineNodeId }: Props) {
  const data = useProjectStore((s) => s.data)
  const granularity = useUIStore((s) => s.granularity)
  const requestLocate = useUIStore((s) => s.requestLocate)
  const expandNode = useUIStore((s) => s.expandNode)
  const runAlignmentCheck = useUIStore((s) => s.runAlignmentCheck)

  const flat = useMemo(
    () => (data ? flattenOutline(data.outline) : []),
    [data]
  )
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [breatheId, setBreatheId] = useState<string | null>(null)

  // 默认展开所有含内容的节点
  useEffect(() => {
    if (!data) return
    setOpen((prev) => {
      const next = new Set(prev)
      for (const { node } of flat) next.add(node.id)
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat.length, data?.meta.updatedAt])

  // 块选中 → 对应大纲节点展开并呼吸高亮
  useEffect(() => {
    if (!activeOutlineNodeId) return
    setOpen((prev) => {
      const next = new Set(prev)
      const path = data ? findPath(data.outline, activeOutlineNodeId) : null
      if (path) for (const n of path) next.add(n.id)
      return next
    })
    setBreatheId(activeOutlineNodeId)
    const t = window.setTimeout(() => setBreatheId(null), 900)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOutlineNodeId])

  if (!data) return null
  const hasOutline = data.outline.length > 0

  const commitRename = (id: string) => {
    const text = draft.trim()
    setEditingId(null)
    if (text) useProjectStore.getState().renameOutlineNode(id, text)
  }

  const locate = (nodeId: string) => {
    const blocks = getDisplayBlocks(data, granularity)
    const target = blocks.find((b) => b.outlineNodeId === nodeId)
    if (target) {
      requestLocate(target.key)
      useUIStore.getState().setActive(target.key)
    } else {
      useUIStore
        .getState()
        .pushToast({ kind: 'info', text: '该节点下暂无正文块' })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div className="sidebar-header">
        <span>大纲</span>
        <span style={{ display: 'flex', gap: 2 }}>
          <button
            className="icon-btn"
            title="新建根节点"
            onClick={() =>
              useProjectStore
                .getState()
                .addOutlineNode({ parentId: null, siblingId: null, title: '新章节' })
            }
          >
            <IconPlus />
          </button>
        </span>
      </div>
      <div className="sidebar-scroll">
        {!hasOutline ? (
          <div className="outline-empty">
            {data.blocks.length > 0 ? (
              <>
                尚未建立大纲
                <br />
                <button
                  className="btn btn-plain"
                  style={{ marginTop: 8, color: 'var(--accent)' }}
                  onClick={() => void useUIStore.getState().runInferOutline()}
                >
                  <IconSparkles size={12} />
                  AI 反推大纲
                </button>
              </>
            ) : (
              <>
                导入文稿后
                <br />
                大纲将自动建立
              </>
            )}
          </div>
        ) : (
          flat.map(({ node, path }) => {
            const depth = path.length - 1
            const expanded = open.has(node.id)
            const hasChildren = node.children.length > 0
            return (
              <div key={node.id}>
                <div
                  className={`outline-row${
                    breatheId === node.id ? ' outline-breathe' : ''
                  }`}
                  style={{ paddingLeft: 8 + depth * 16 }}
                >
                  <button
                    className={`chevron${expanded ? ' open' : ''}${
                      hasChildren ? '' : ' leaf'
                    }`}
                    onClick={() =>
                      setOpen((prev) => {
                        const next = new Set(prev)
                        if (next.has(node.id)) next.delete(node.id)
                        else next.add(node.id)
                        return next
                      })
                    }
                    aria-label="展开或折叠"
                    tabIndex={-1}
                  >
                    <IconChevron size={12} />
                  </button>
                  {editingId === node.id ? (
                    <input
                      className="outline-title-input"
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(node.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(node.id)
                        if (e.key === 'Escape') setEditingId(null)
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
                      title={`${node.title}（单击定位 · 双击重命名）`}
                    >
                      {node.title}
                    </span>
                  )}
                  <span className="outline-actions">
                    <button
                      className="icon-btn"
                      title="AI 扩写此章节"
                      onClick={() => void expandNode(node.id)}
                    >
                      <IconSparkles size={12} />
                    </button>
                    <button
                      className="icon-btn"
                      title="新增子节点"
                      onClick={() =>
                        useProjectStore.getState().addOutlineNode({
                          parentId: node.id,
                          siblingId: null,
                          title: '新小节',
                        })
                      }
                    >
                      <IconPlus size={12} />
                    </button>
                    <button
                      className="icon-btn"
                      title="删除节点（其下块变为未挂靠）"
                      onClick={() =>
                        useProjectStore.getState().deleteOutlineNode(node.id)
                      }
                    >
                      <IconTrash size={12} />
                    </button>
                  </span>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** 找节点路径（根→自身），找不到返回 null */
function findPath(
  nodes: OutlineNode[],
  id: string
): OutlineNodeWithPath['path'] | null {
  const walk = (
    list: OutlineNode[],
    path: OutlineNodeWithPath['path']
  ): OutlineNodeWithPath['path'] | null => {
    for (const n of list) {
      const next = [...path, n]
      if (n.id === id) return next
      const found = walk(n.children, next)
      if (found) return found
    }
    return null
  }
  return walk(nodes, [])
}

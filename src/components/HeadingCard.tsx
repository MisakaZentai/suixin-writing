/**
 * 标题块：正文里的章节标题，也是大纲的唯一来源。
 * 单击选中，E / 双击就地改名；右键可升降级、转为正文、AI 扩写或检查本节。
 */
import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { HeadingBlock } from '../types'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { MenuItem, clampMenu, handleEditorKey } from './BlockCard'
import { AIErrorStrip, AIPromptBox } from './AIPromptBox'
import { checkSection, expandSection } from '../store/aiActions'
import { IconComment, IconEdit, IconSparkles } from './icons'
import { PendingInsertLink } from './PendingInsertLink'

interface Props {
  block: HeadingBlock
  enterDelay?: number
}

export const HeadingCard = memo(function HeadingCard({ block, enterDelay = 0 }: Props) {
  const id = block.id
  const active = useUIStore((s) => s.activeId === id)
  const editing = useUIStore((s) => (s.editing?.id === id ? s.editing : null))
  const menu = useUIStore((s) => (s.contextMenu?.id === id ? s.contextMenu : null))
  const streaming = useUIStore((s) => s.stream != null)
  const prompt = useUIStore((s) =>
    s.aiPrompt && s.aiPrompt.scope.anchorId === id && s.aiPrompt.scope.kind === 'section' ? s.aiPrompt : null
  )
  const inSelection = useUIStore((s) => s.selection?.ids.includes(id) ?? false)
  const inputRef = useRef<HTMLInputElement>(null)
  const ui = () => useUIStore.getState()
  const store = () => useProjectStore.getState()

  useLayoutEffect(() => {
    const el = inputRef.current
    if (!editing || !el) return
    el.focus({ preventScroll: true })
    const caret = Math.min(editing.caret ?? el.value.length, el.value.length)
    el.setSelectionRange(caret, caret)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.token])

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest('.context-menu')) return
      ui().setContextMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const closeMenu = () => ui().setContextMenu(null)
  const Tag = `h${Math.min(block.level, 6)}` as 'h2'

  return (
    <div
      className={`heading-block level-${block.level}${active ? ' active' : ''}${editing ? ' edit' : ''}${
        inSelection ? ' in-selection' : ''
      }`}
      data-block-id={id}
      style={enterDelay ? { animationDelay: `${enterDelay}ms` } : undefined}
      onClick={(e) => {
        if (editing) return
        const { activeId, selection } = ui()
        if (e.shiftKey && activeId && activeId !== id) {
          ui().selectRange(selection?.anchorId ?? activeId, id)
          return
        }
        if (activeId !== id || selection) ui().setActive(id)
      }}
      onDoubleClick={() => {
        if (!editing) ui().beginEdit(id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        ui().setActive(id)
        ui().setContextMenu({ x: e.clientX, y: e.clientY, id })
      }}
    >
      <span className="block-anchor" />
      {editing ? (
        <input
          ref={inputRef}
          className={`heading-input heading-text level-${block.level}`}
          value={editing.draft}
          aria-label="编辑标题"
          onChange={(e) => ui().updateEditDraft(e.target.value)}
          onBlur={() => {
            if (document.hasFocus() && ui().editing?.id === id) ui().confirmEdit()
          }}
          onKeyDown={(e) => handleEditorKey(e, id)}
        />
      ) : (
        <Tag className={`heading-text level-${block.level}`}>{block.text || '（无标题）'}</Tag>
      )}
      {!editing && <PendingInsertLink afterId={id} />}

      {active && !editing && !prompt && (
        <div className="floating-toolbar">
          <button className="tool-btn" onClick={() => ui().beginEdit(id)} title="改标题（E 或双击）">
            <IconEdit />
            改标题
            <span className="kbd">E</span>
          </button>
          <button
            className="tool-btn"
            disabled={streaming}
            onClick={() => ui().openAIPrompt()}
            title="让 AI 处理这一节的正文：润色、精简、扩写、续写，或写下你的要求（空格）"
          >
            <IconSparkles />
            AI 处理本节
            <span className="kbd">空格</span>
          </button>
          <button
            className="tool-btn"
            onClick={() => void checkSection(id)}
            title="检查这一节是否偏题、重复或顺序不当（只给建议，不改正文）"
          >
            <IconComment />
            检查本节
          </button>
        </div>
      )}
      {prompt && <AIPromptBox scope={prompt.scope} />}
      <AIErrorStrip anchorId={id} />

      {menu &&
        createPortal(
          <div
            className="context-menu"
            style={clampMenu(menu.x, menu.y)}
            // portal 里的 React 事件仍会冒泡回卡片本身，必须拦住
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <MenuItem label="改标题" kbd="E" onClick={() => (closeMenu(), ui().beginEdit(id))} />
            <MenuItem
              label="升一级（整节）"
              onClick={() => (closeMenu(), void store().shiftSectionLevel(id, -1))}
            />
            <MenuItem
              label="降一级（整节）"
              onClick={() => (closeMenu(), void store().shiftSectionLevel(id, 1))}
            />
            <MenuItem
              label="在下方插入段落"
              onClick={() => {
                closeMenu()
                const fresh = store().insertParagraphAfter(id)
                if (fresh) ui().beginEdit(fresh)
              }}
            />
            <div className="context-menu-sep" />
            <MenuItem label="AI 扩写本节" onClick={() => (closeMenu(), void expandSection(id))} />
            <MenuItem label="检查本节" onClick={() => (closeMenu(), void checkSection(id))} />
            <div className="context-menu-sep" />
            <MenuItem label="转为正文" onClick={() => (closeMenu(), store().convertBlock(id, 'paragraph'))} />
            <MenuItem
              label="删除标题（保留正文）"
              danger
              onClick={() => {
                closeMenu()
                store().removeBlock(id)
                ui().pushToast({
                  kind: 'info',
                  text: '标题已删除，正文并入上一节',
                  actionLabel: '撤销',
                  onAction: () => store().undo(),
                  duration: 5000,
                })
              }}
            />
          </div>,
          document.body
        )}
    </div>
  )
})

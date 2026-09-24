/**
 * 编辑时的 Markdown：输入框下面垫一层同样排版的"带样式源码"（语法就地生效），
 * 选中文字时浮出格式浮条（也可用 Ctrl+B / Ctrl+I / Ctrl+K）。
 *
 * 改动都经 execCommand('insertText') 写进输入框，与手打的字一样进原生撤销栈，Ctrl+Z 可撤销。
 */
import { forwardRef, useCallback, useEffect, useState, type RefObject } from 'react'
import { applyEdit, makeLink, toggleLines, toggleWrap, type Edit, type LineFormat, type WrapFormat } from '../lib/md'
import { MdText } from './MdText'

/** 垫在输入框下面的带样式源码；visible=false 时只用来量选区位置 */
export const MdBackdrop = forwardRef<HTMLParagraphElement, { text: string; visible: boolean }>(function MdBackdrop(
  { text, visible },
  ref
) {
  return (
    <p ref={ref} className={`prose md-source md-backdrop${visible ? '' : ' measure-only'}`} aria-hidden="true">
      <MdText text={text} mode="source" plain={!visible} />
      {/* 末尾是换行时，输入框会多出一个空行，这里也要撑出来 */}
      {'​'}
    </p>
  )
})

export type FormatAction = WrapFormat | 'link' | LineFormat

export function editFor(text: string, start: number, end: number, action: FormatAction): Edit {
  if (action === 'link') return makeLink(text, start, end)
  if (action === 'ul' || action === 'ol' || action === 'quote') return toggleLines(text, start, end, action)
  return toggleWrap(text, start, end, action)
}

/** 把格式操作写进输入框（进原生撤销栈），并选中结果 */
export function applyFormat(el: HTMLTextAreaElement, action: FormatAction): void {
  const edit = editFor(el.value, el.selectionStart, el.selectionEnd, action)
  el.focus()
  el.setSelectionRange(edit.from, edit.to)
  const ok = edit.insert || edit.to > edit.from ? document.execCommand('insertText', false, edit.insert) : true
  if (!ok) {
    // 不支持 execCommand 的环境：直接改值并通知 React
    const next = applyEdit(el.value, edit)
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(el, next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  el.setSelectionRange(edit.selStart, edit.selEnd)
}

/** 编辑框里的格式快捷键；处理了返回 true */
export function formatShortcut(e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): boolean {
  const el = e.currentTarget
  if (!(el instanceof HTMLTextAreaElement) || !(e.ctrlKey || e.metaKey) || e.altKey) return false
  const key = e.key.toLowerCase()
  const action: FormatAction | null = e.shiftKey
    ? key === 'x'
      ? 'del'
      : null
    : key === 'b'
      ? 'strong'
      : key === 'i'
        ? 'em'
        : key === 'k'
          ? 'link'
          : key === 'e'
            ? 'code'
            : null
  if (!action) return false
  e.preventDefault()
  e.stopPropagation()
  applyFormat(el, action)
  return true
}

const BUTTONS: { action: FormatAction; label: string; title: string; className?: string }[] = [
  { action: 'strong', label: 'B', title: '加粗（Ctrl+B）', className: 'fmt-strong' },
  { action: 'em', label: 'I', title: '斜体（Ctrl+I）', className: 'fmt-em' },
  { action: 'del', label: 'S', title: '删除线（Ctrl+Shift+X）', className: 'fmt-del' },
  { action: 'code', label: '</>', title: '行内代码（Ctrl+E）', className: 'fmt-code' },
  { action: 'link', label: '链接', title: '链接（Ctrl+K）' },
  { action: 'ul', label: '• 列表', title: '无序列表' },
  { action: 'ol', label: '1. 列表', title: '有序列表' },
  { action: 'quote', label: '引用', title: '引用' },
]

/** 格式按钮（编辑框的浮条与阅读时的划选浮条共用） */
export function FormatButtons({ onAction }: { onAction: (a: FormatAction) => void }) {
  return (
    <>
      {BUTTONS.map((b, i) => (
        <button
          key={b.action}
          className={`fmt-btn${b.className ? ` ${b.className}` : ''}${i === 5 ? ' fmt-sep' : ''}`}
          title={b.title}
          aria-label={b.title.replace(/（.*）/, '')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onAction(b.action)}
        >
          {b.label}
        </button>
      ))}
    </>
  )
}

/** 选区在垫层里的位置（相对编辑区） */
function selectionRect(backdrop: HTMLElement, start: number): { top: number; left: number } | null {
  const walker = document.createTreeWalker(backdrop, NodeFilter.SHOW_TEXT)
  let total = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent?.length ?? 0
    if (start <= total + len) {
      const range = document.createRange()
      const at = Math.min(start - total, len)
      range.setStart(n, at)
      range.setEnd(n, Math.min(at + 1, len))
      const r = range.getClientRects()[0] ?? range.getBoundingClientRect()
      const host = backdrop.getBoundingClientRect()
      return { top: r.top - host.top, left: r.left - host.left }
    }
    total += len
  }
  return null
}

/** 编辑框里选中文字时浮出的格式浮条 */
export function FormatBar({
  textareaRef,
  backdropRef,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  backdropRef: RefObject<HTMLParagraphElement | null>
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const update = useCallback(() => {
    const el = textareaRef.current
    const bd = backdropRef.current
    if (!el || !bd || document.activeElement !== el || el.selectionStart === el.selectionEnd) {
      setPos(null)
      return
    }
    const r = selectionRect(bd, el.selectionStart)
    if (!r) return setPos(null)
    const width = bd.clientWidth
    setPos({ top: r.top - 40, left: Math.max(0, Math.min(r.left - 12, width - 330)) })
  }, [textareaRef, backdropRef])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const later = () => requestAnimationFrame(update)
    const events = ['select', 'keyup', 'mouseup', 'input', 'blur'] as const
    events.forEach((ev) => el.addEventListener(ev, later))
    document.addEventListener('selectionchange', later)
    return () => {
      events.forEach((ev) => el.removeEventListener(ev, later))
      document.removeEventListener('selectionchange', later)
    }
  }, [textareaRef, update])

  if (!pos) return null
  return (
    <div className="format-bar" role="toolbar" aria-label="格式" style={{ top: pos.top, left: pos.left }}>
      <FormatButtons
        onAction={(a) => {
          const el = textareaRef.current
          if (el) applyFormat(el, a)
          requestAnimationFrame(update)
        }}
      />
    </div>
  )
}

/**
 * 键盘 hook：全局快捷键（spec §6.3）。
 * 输入控件聚焦时只放行 Esc / Ctrl 组合键。
 */
import { useEffect } from 'react'
import { isImeKey } from '../lib/ime'

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

/** 输入框内由浏览器原生处理的编辑快捷键 */
const TEXT_EDIT_KEYS = new Set(['z', 'y', 'a', 'c', 'v', 'x'])

export interface ShortcutHandlers {
  onKey: (e: KeyboardEvent) => void
  /** 粘贴导入（空文档时 Ctrl+V） */
  onPaste?: (e: ClipboardEvent) => void
}

export function useShortcuts({ onKey, onPaste }: ShortcutHandlers): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // 输入法组字期间的按键一律交给输入法
      if (isImeKey(e)) return
      if (isTypingTarget(e.target)) {
        // 输入态只放行 Esc 与文稿级组合键；撤销 / 重做 / 剪贴板等编辑键
        // 必须留给输入框自己，否则 Ctrl+Z 会撤销整篇文稿的上一步操作
        if (e.key === 'Escape') onKey(e)
        else if ((e.ctrlKey || e.metaKey) && !TEXT_EDIT_KEYS.has(e.key.toLowerCase())) onKey(e)
        return
      }
      onKey(e)
    }
    const paste = (e: ClipboardEvent): void => {
      if (onPaste) onPaste(e)
    }
    window.addEventListener('keydown', handler)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('paste', paste)
    }
  }, [onKey, onPaste])
}

/**
 * 键盘按下时让 UI 上对应按钮做一次 pressed 回声（design §6.3-4）。
 * 返回一个触发器：传入 ref 与按键。
 */
export function pressEcho(el: HTMLElement | null): void {
  if (!el) return
  el.classList.remove('pressed-echo')
  void el.offsetWidth
  el.classList.add('pressed-echo')
  window.setTimeout(() => el.classList.remove('pressed-echo'), 120)
}

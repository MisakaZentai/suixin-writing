/**
 * Toast 栈（design §5.8 sheet-drop）。
 * 入场用 store 数据；离场在本地保留一帧播放 toast-out（220ms 向上收起）。
 */
import { useEffect, useRef, useState } from 'react'
import { useUIStore, type Toast as ToastModel } from '../store/uiStore'

const TOAST_ICON: Record<ToastModel['kind'], string> = {
  success: '✓',
  error: '!',
  info: 'i',
}

const LEAVE_MS = 220

export function Toasts() {
  const toasts = useUIStore((s) => s.toasts)
  const dismiss = useUIStore((s) => s.dismissToast)
  const [leaving, setLeaving] = useState<ToastModel[]>([])
  const prevRef = useRef<ToastModel[]>([])
  const timersRef = useRef<number[]>([])

  /* store 中消失的 toast 在本地多留 LEAVE_MS 播离开动画。
     计时器只由自身触发或组件卸载清除——不能被后续 toast 变更的
     effect cleanup 提前清掉（否则 leaving 永久残留）。 */
  useEffect(() => {
    const gone = prevRef.current.filter((t) => !toasts.some((x) => x.id === t.id))
    prevRef.current = toasts
    if (!gone.length) return
    setLeaving((v) => [
      ...v.filter((old) => !gone.some((g) => g.id === old.id)),
      ...gone,
    ])
    for (const t of gone) {
      timersRef.current.push(
        window.setTimeout(
          () => setLeaving((v) => v.filter((x) => x.id !== t.id)),
          LEAVE_MS
        )
      )
    }
  }, [toasts])

  useEffect(
    () => () => {
      timersRef.current.forEach((id) => window.clearTimeout(id))
      timersRef.current = []
    },
    []
  )

  const render = (t: ToastModel, isLeaving: boolean) => (
    <div
      key={`${isLeaving ? 'leave' : 'live'}-${t.id}`}
      className={`toast ${t.kind}${isLeaving ? ' leaving' : ''}`}
      role="status"
    >
      <span className="toast-icon">{TOAST_ICON[t.kind]}</span>
      <span>{t.text}</span>
      {t.actionLabel && !isLeaving && (
        <button
          className="toast-action"
          onClick={() => {
            t.onAction?.()
            dismiss(t.id)
          }}
        >
          {t.actionLabel}
        </button>
      )}
    </div>
  )

  if (!toasts.length && !leaving.length) return null
  return (
    <div className="toast-stack">
      {toasts.map((t) => render(t, false))}
      {leaving.map((t) => render(t, true))}
    </div>
  )
}

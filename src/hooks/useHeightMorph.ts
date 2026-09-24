/**
 * height-morph：同一容器在三态间连续形变（design §5.3）。
 * 旧内容以绝对定位幽灵层交叉淡化，布局高度与内容透明度双轨并行。
 *
 * 实现要点（修复后）：
 * - 每次渲染后记录容器高度 lastHeight，mode 变化时以 lastHeight 作为
 *   FLIP 起点，避免在 React 提交后测量到错误的新高度；
 * - 幽灵层初始 opacity 为 1，配合 CSS transition 淡出；当前层
 *   通过 .morphing class 触发 fade-in；
 * - transitionend 不可靠（元素卸载/被打断），始终设置定时器兜底清理。
 */
import { useLayoutEffect, useRef, useState } from 'react'

export interface MorphGhost {
  /** 旧状态的标识，调用方据此渲染旧内容 */
  from: string
}

export function useHeightMorph<T extends HTMLElement>(mode: string) {
  const ref = useRef<T>(null)
  const prevMode = useRef(mode)
  const lastHeight = useRef(0)
  const [ghost, setGhost] = useState<MorphGhost | null>(null)

  // 每次渲染后都记录当前高度（FLIP 的 First）
  useLayoutEffect(() => {
    const el = ref.current
    if (el) lastHeight.current = el.getBoundingClientRect().height
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || prevMode.current === mode) return

    const from = prevMode.current
    prevMode.current = mode

    const startH = lastHeight.current
    // 先让 DOM 以自然高度渲染新内容，测量目标高度
    el.style.height = 'auto'
    const newH = el.getBoundingClientRect().height
    // 钉回旧高度，触发幽灵层
    el.style.height = `${startH}px`
    setGhost({ from })

    void el.offsetHeight // 强制 reflow，确保起点生效
    requestAnimationFrame(() => {
      el.classList.add('morphing')
      el.style.height = `${newH}px`
    })

    const cleanup = () => {
      el.style.height = ''
      el.classList.remove('morphing')
      setGhost(null)
      el.removeEventListener('transitionend', cleanup)
      window.clearTimeout(timer)
    }

    // 280ms 动画 + 100ms 冗余，防止 transitionend 丢失导致幽灵层泄漏
    const timer = window.setTimeout(cleanup, 380)
    el.addEventListener('transitionend', cleanup)

    return () => {
      el.style.height = ''
      el.classList.remove('morphing')
      el.removeEventListener('transitionend', cleanup)
      window.clearTimeout(timer)
      setGhost(null)
    }
  }, [mode])

  return { ref, ghost }
}

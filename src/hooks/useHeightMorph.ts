/**
 * height-morph：同一容器在三态间连续形变（design §5.3）。
 * 旧内容以绝对定位幽灵层交叉淡化，布局高度与内容透明度双轨并行。
 */
import { useLayoutEffect, useRef, useState } from 'react'

export interface MorphGhost {
  /** 旧状态的标识，调用方据此渲染旧内容 */
  from: string
}

export function useHeightMorph<T extends HTMLElement>(mode: string) {
  const ref = useRef<T>(null)
  const prevMode = useRef(mode)
  const [ghost, setGhost] = useState<MorphGhost | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || prevMode.current === mode) return
    const from = prevMode.current
    prevMode.current = mode
    const startH = el.getBoundingClientRect().height
    setGhost({ from })
    // 测量新内容的自然高度
    el.style.height = 'auto'
    const newH = el.getBoundingClientRect().height
    el.style.height = `${startH}px`
    void el.offsetHeight // 强制 reflow，确保起点生效
    requestAnimationFrame(() => {
      el.style.height = `${newH}px`
    })
    const onEnd = () => {
      el.style.height = ''
      setGhost(null)
      el.removeEventListener('transitionend', onEnd)
    }
    el.addEventListener('transitionend', onEnd)
    return () => {
      el.style.height = ''
      el.removeEventListener('transitionend', onEnd)
      setGhost(null)
    }
  }, [mode])

  return { ref, ghost }
}

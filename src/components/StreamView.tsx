/**
 * 流式生成态：打字机缓冲渲染（design §3.3）。
 *
 * 性能纪律：rAF 每帧吐字时直接写 DOM textContent，不触发 React
 * 重渲染——5 万字文档的块流里，这是打字机不掉帧的关键。
 */
import { useEffect, useRef } from 'react'
import type { Typewriter } from '../lib/typewriter'
import { IconX } from './icons'

interface Props {
  tw: Typewriter
  onAbort: () => void
}

export function StreamView({ tw, onAbort }: Props) {
  const textRef = useRef<HTMLSpanElement>(null)
  const caretRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    return tw.subscribe((s) => {
      if (textRef.current) textRef.current.textContent = s.shown
      // 生成完成瞬间：光标圆点缩小消失（150ms）
      caretRef.current?.classList.toggle('done', s.done)
    })
  }, [tw])

  return (
    <div style={{ position: 'relative' }}>
      <p className="prose block-text">
        <span ref={textRef} />
        <span ref={caretRef} className="typewriter-caret" />
      </p>
      <div
        className="stream-meta"
        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
      >
        <span className="stream-indicator">
          <span className="dot" />
          生成中…
        </span>
        <button
          className="icon-btn"
          style={{ width: 20, height: 20 }}
          onClick={onAbort}
          title="中断生成（Esc）"
        >
          <IconX size={12} />
        </button>
      </div>
    </div>
  )
}

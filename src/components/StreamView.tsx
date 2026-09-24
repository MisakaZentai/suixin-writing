/** 流式生成态：打字机缓冲渲染（design §3.3） */
import { useEffect, useState } from 'react'
import type { Typewriter } from '../lib/typewriter'
import { IconX } from './icons'

interface Props {
  tw: Typewriter
  onAbort: () => void
}

export function StreamView({ tw, onAbort }: Props) {
  const [shown, setShown] = useState('')

  useEffect(() => tw.subscribe((s) => setShown(s.shown)), [tw])

  return (
    <div style={{ position: 'relative' }}>
      <p className="prose block-text">
        {shown}
        <span className="typewriter-caret" />
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

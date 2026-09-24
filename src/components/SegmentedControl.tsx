/**
 * 顶栏粒度切换器：FLIP thumb 滑动（design §5.2「全应用手感最精的组件」）。
 * 切换时 thumb 不跳变：记录旧位置 → transform 补偿 → 弹簧滑向新位置；
 * 宽度同步形变插值。键盘 1/2/3 与点击走同一动画路径。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface SegmentedItem<T extends string> {
  value: T
  label: string
  hint?: string
}

interface Props<T extends string> {
  value: T
  items: SegmentedItem<T>[]
  onChange: (value: T) => void
  ariaLabel?: string
}

export function SegmentedControl<T extends string>({
  value,
  items,
  onChange,
  ariaLabel,
}: Props<T>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState({ left: 0, width: 0, ready: false })

  const measure = (animate: boolean) => {
    const container = containerRef.current
    const thumbEl = thumbRef.current
    if (!container || !thumbEl) return
    const nodes = container.querySelectorAll<HTMLElement>('[data-seg-item]')
    const idx = items.findIndex((i) => i.value === value)
    const btn = nodes[idx]
    if (!btn) return
    const left = btn.offsetLeft
    const width = btn.offsetWidth
    if (animate) {
      const cRect = container.getBoundingClientRect()
      const tRect = thumbEl.getBoundingClientRect()
      // FLIP：先瞬移回旧位置，再靠 CSS transition 滑向新位置
      thumbEl.style.transition = 'none'
      thumbEl.style.transform = `translateX(${tRect.left - cRect.left}px)`
      thumbEl.style.width = `${tRect.width}px`
      void thumbEl.offsetWidth
      thumbEl.style.transition = ''
    }
    setThumb({ left, width, ready: true })
  }

  useLayoutEffect(() => {
    measure(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    measure(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, items.length])

  // 容器尺寸变化（窗口缩放）时重新对位
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure(false))
    ro.observe(container)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel} ref={containerRef}>
      <div
        ref={thumbRef}
        className="segmented-thumb"
        style={{
          transform: `translateX(${thumb.left}px)`,
          width: `${thumb.width}px`,
          opacity: thumb.ready ? 1 : 0,
          transition:
            'transform var(--dur-slow) var(--spring-gentle), width var(--dur-slow) var(--spring-gentle), opacity 100ms linear',
        }}
      />
      {items.map((item) => (
        <button
          key={item.value}
          data-seg-item
          role="tab"
          aria-selected={item.value === value}
          className={`segmented-item${item.value === value ? ' selected' : ''}`}
          onClick={() => onChange(item.value)}
          title={item.hint}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

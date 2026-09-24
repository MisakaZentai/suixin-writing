/**
 * 顶栏粒度切换器（design §5.2「全应用手感最精的组件」）。
 * thumb 的位置/宽度由 React state 驱动，CSS transition 负责平滑滑动——
 * transform 与 width 同源过渡天然等价于 FLIP（弹簧曲线、宽度形变插值），
 * 无需手动补偿代码。键盘 1/2/3 与点击走同一动画路径。
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
  const [thumb, setThumb] = useState({ left: 0, width: 0, ready: false })

  const measure = () => {
    const container = containerRef.current
    if (!container) return
    const nodes = container.querySelectorAll<HTMLElement>('[data-seg-item]')
    const idx = items.findIndex((i) => i.value === value)
    const btn = nodes[idx]
    if (!btn) return
    setThumb({ left: btn.offsetLeft, width: btn.offsetWidth, ready: true })
  }

  useLayoutEffect(measure, [])

  useEffect(measure, [value, items.length])

  // 容器尺寸变化（窗口缩放/字体加载）时重新对位
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(container)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel} ref={containerRef}>
      <div
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

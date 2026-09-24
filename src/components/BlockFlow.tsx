/**
 * 块流容器（design §4 / §5.6）。
 * 职责：粒度视图渲染、滚动驱动顶栏 hairline、大纲定位（reveal + 呼吸高亮）。
 */
import { useEffect, useMemo, useRef } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { getDisplayBlocks } from '../lib/project'
import { BlockCard } from './BlockCard'

interface Props {
  onScrolledChange: (scrolled: boolean) => void
}

export function BlockFlow({ onScrolledChange }: Props) {
  const data = useProjectStore((s) => s.data)
  const granularity = useUIStore((s) => s.granularity)
  const activeKey = useUIStore((s) => s.activeKey)
  const locateRequest = useUIStore((s) => s.locateRequest)
  const scrollRef = useRef<HTMLDivElement>(null)

  const blocks = useMemo(
    () => (data ? getDisplayBlocks(data, granularity) : []),
    [data, granularity]
  )

  /* 滚动 → 顶栏 hairline（内容“到顶”的空间暗示） */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => onScrolledChange(el.scrollTop > 4)
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [onScrolledChange])

  /* 大纲定位请求 → 平滑滚动入视 + block-group-highlight 呼吸高亮 */
  useEffect(() => {
    if (!locateRequest) return
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-block-key="${locateRequest.key.replace(/"/g, '\\"')}"]`
    )
    if (!el) return
    const reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
    el.classList.remove('block-group-highlight')
    void el.offsetWidth
    el.classList.add('block-group-highlight')
    const t = window.setTimeout(
      () => el.classList.remove('block-group-highlight'),
      900
    )
    return () => window.clearTimeout(t)
  }, [locateRequest])

  return (
    <div
      className="column-wrap"
      ref={scrollRef}
      onMouseDown={(e) => {
        // 点击空白处取消块选中
        if (e.target === e.currentTarget) useUIStore.getState().setActive(null)
      }}
    >
      <div className="column">
        {blocks.length === 0 ? (
          <div className="empty-holder">
            <p style={{ color: 'var(--text-tertiary)', fontSize: 13, lineHeight: 1.8 }}>
              文稿还没有正文。
              <br />
              用顶部「导入」粘贴或打开一份文档，AI 会自动拆块。
            </p>
          </div>
        ) : (
          <div className="block-flow">
            {blocks.map((b, i) => (
              <BlockCard
                key={b.key}
                block={b}
                prevBlock={i > 0 ? blocks[i - 1] : null}
                active={activeKey === b.key}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

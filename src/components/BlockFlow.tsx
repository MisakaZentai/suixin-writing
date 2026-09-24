/**
 * 正文流：按顺序渲染标题与段落。
 * 职责：滚动驱动顶栏分隔线、定位请求（滚动 + 高亮整节）、插入型生成内容的落点。
 */
import { memo, useEffect, useMemo, useRef } from 'react'
import type { DocBlock, HeadingBlock } from '../types'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { headingPaths, sectionEnd } from '../lib/doc'
import { BlockCard } from './BlockCard'
import { HeadingCard } from './HeadingCard'
import { InsertionCard } from './InsertionCard'
import { SelectionBubble } from './SelectionBubble'

interface Props {
  onScrolledChange: (scrolled: boolean) => void
}

export function BlockFlow({ onScrolledChange }: Props) {
  const blocks = useProjectStore((s) => s.data?.blocks)
  const locateRequest = useUIStore((s) => s.locateRequest)
  const insertAnchor = useUIStore((s) =>
    s.stream?.insert ? s.stream.anchorId : s.diff?.insert ? s.diff.anchorId : undefined
  )
  const scrollRef = useRef<HTMLDivElement>(null)

  const paths = useMemo(() => (blocks ? headingPaths(blocks) : new Map()), [blocks])

  /* 划选文字：段内 → 段内片段（可单独交给 AI）；跨段 → 多段选区 */
  useEffect(() => {
    let raf = 0
    const read = () => {
      raf = 0
      const ui = useUIStore.getState()
      if (ui.editing || ui.aiPrompt) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        if (ui.textRange) ui.setTextRange(null)
        return
      }
      const range = sel.getRangeAt(0)
      const textOf = (node: Node) =>
        (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest<HTMLElement>(
          '.block .block-text'
        ) ?? null
      const startEl = textOf(range.startContainer)
      const endEl = textOf(range.endContainer)
      const idOf = (el: HTMLElement | null) => el?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId ?? null
      const startId = idOf(startEl)
      const endId = idOf(endEl)
      if (!startEl || !startId || !endId) {
        if (ui.textRange) ui.setTextRange(null)
        return
      }
      if (startId === endId) {
        const start = textOffset(startEl, range.startContainer, range.startOffset)
        const end = textOffset(startEl, range.endContainer, range.endOffset)
        if (start == null || end == null || end <= start) return
        const r = range.getBoundingClientRect()
        if (ui.activeId !== startId) useUIStore.setState({ activeId: startId, selection: null })
        ui.setTextRange({
          blockId: startId,
          start,
          end,
          rect: { top: r.top, left: r.left, width: r.width, bottom: r.bottom },
        })
      } else {
        ui.setTextRange(null)
        if (ui.selection?.anchorId !== startId || ui.selection?.focusId !== endId) ui.selectRange(startId, endId)
      }
    }
    const onChange = () => {
      if (!raf) raf = requestAnimationFrame(read)
    }
    document.addEventListener('selectionchange', onChange)
    return () => {
      document.removeEventListener('selectionchange', onChange)
      cancelAnimationFrame(raf)
    }
  }, [])

  /* 滚动 → 顶栏分隔线（内容"到顶"的空间暗示） */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => onScrolledChange(el.scrollTop > 4)
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [onScrolledChange])

  /* 定位请求 → 平滑滚动入视 + 整节高亮 */
  useEffect(() => {
    if (!locateRequest || !blocks) return
    const root = scrollRef.current
    const el = root?.querySelector<HTMLElement>(`[data-block-id="${locateRequest.id}"]`)
    if (!root || !el) return
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
    const idx = blocks.findIndex((b) => b.id === locateRequest.id)
    const end = blocks[idx]?.type === 'heading' ? sectionEnd(blocks, idx) : idx + 1
    const targets = blocks
      .slice(idx, end)
      .map((b) => root.querySelector<HTMLElement>(`[data-block-id="${b.id}"]`))
      .filter((x): x is HTMLElement => x !== null)
    for (const t of targets) {
      t.classList.remove('block-group-highlight')
      void t.offsetWidth
      t.classList.add('block-group-highlight')
    }
    const timer = window.setTimeout(
      () => targets.forEach((t) => t.classList.remove('block-group-highlight')),
      900
    )
    return () => window.clearTimeout(timer)
  }, [locateRequest, blocks])

  if (!blocks) return null

  return (
    <div
      className="column-wrap"
      ref={scrollRef}
      onMouseDown={(e) => {
        // 点击空白处取消选中
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('column')) {
          useUIStore.getState().setActive(null)
        }
      }}
    >
      <SelectionBubble />
      <div className="column">
        {blocks.length === 0 ? (
          <div className="empty-holder">
            <p style={{ color: 'var(--text-tertiary)', fontSize: 13, lineHeight: 1.8 }}>
              文稿还没有正文。
            </p>
          </div>
        ) : (
          <div className="block-flow">
            {insertAnchor === null && <InsertionCard />}
            {blocks.map((b, i) => (
              <FlowItem
                key={b.id}
                block={b}
                index={i}
                prevIsParagraph={i > 0 && blocks[i - 1].type === 'paragraph'}
                pathText={pathTextOf(paths.get(b.id))}
                parentLevel={paths.get(b.id)?.slice(-1)[0]?.level ?? 1}
                insertHere={insertAnchor === b.id}
              />
            ))}
            <button className="continue-writing" onClick={() => useUIStore.getState().continueWriting()}>
              继续写…
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** 标题路径拼成字符串：内容不变时 props 不变，段落卡片的 memo 才能生效 */
function pathTextOf(path: HeadingBlock[] | undefined): string {
  return path?.map((h) => h.text).join(' / ') ?? ''
}

const FlowItem = memo(function FlowItem({
  block,
  index,
  prevIsParagraph,
  pathText,
  parentLevel,
  insertHere,
}: {
  block: DocBlock
  index: number
  prevIsParagraph: boolean
  pathText: string
  parentLevel: number
  insertHere: boolean
}) {
  /* 入场 cascade：前 8 块依次浮起，其余直接显示，防长文档动画拖沓 */
  const enterDelay = index <= 8 ? index * 25 : 0
  return (
    <>
      {block.type === 'heading' ? (
        <HeadingCard block={block} enterDelay={enterDelay} />
      ) : (
        <BlockCard
          block={block}
          pathText={pathText}
          parentLevel={parentLevel}
          canMergeUp={prevIsParagraph}
          enterDelay={enterDelay}
        />
      )}
      {insertHere && <InsertionCard />}
    </>
  )
})

/** 选区端点 → 段落文字内的偏移 */
function textOffset(root: HTMLElement, node: Node, offset: number): number | null {
  if (node.nodeType !== Node.TEXT_NODE) {
    // 端点落在元素上：换算成其前面所有文字的长度
    const range = document.createRange()
    range.selectNodeContents(root)
    try {
      range.setEnd(node, offset)
    } catch {
      return null
    }
    return range.toString().length
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let total = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return total + offset
    total += n.textContent?.length ?? 0
  }
  return null
}

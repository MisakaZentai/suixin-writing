/** 段落版本历史：每个版本的来源、时间与内容预览，可恢复到任一版本 */
import { useEffect, useRef } from 'react'
import type { DocBlock, VersionSource } from '../types'

const SOURCE_LABEL: Record<VersionSource, string> = {
  import: '导入',
  manual: '手动编辑',
  ai_rewrite: 'AI 重写',
  ai_revise: 'AI 按意见修改',
  merge: '合并',
  split: '拆分',
  rollback: '恢复',
  convert: '转换',
  agent: 'Agent',
}

export function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(t).toLocaleDateString()
}

export function VersionPopover({
  block,
  onClose,
  onRestore,
}: {
  block: DocBlock
  onClose: () => void
  onRestore: (index: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      if ((e.target as HTMLElement | null)?.closest('.floating-toolbar')) return
      onClose()
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [onClose])

  const versions = [...block.versions].reverse()
  const currentIndex = block.versions.length - 1

  return (
    <div ref={ref} className="popover version-popover" role="dialog" aria-label="版本历史">
      <div className="popover-title">版本历史 · 点击恢复（恢复本身也会记为新版本）</div>
      {versions.map((v, i) => {
        const index = currentIndex - i
        const current = index === currentIndex
        return (
          <button
            key={`${v.v}-${index}`}
            className={`version-item${current ? ' current' : ''}`}
            disabled={current}
            onClick={() => onRestore(index)}
          >
            <span className="v-head">
              <span className="v-tag">v{v.v}</span>
              <span className="v-source">
                {SOURCE_LABEL[v.source] ?? v.source}
                {v.author ? ` · ${v.author}` : ''}
                {v.source === 'rollback' && v.instruction ? `（至 ${v.instruction}）` : ''}
              </span>
              <span className="v-time">{current ? '当前' : relativeTime(v.at)}</span>
            </span>
            <span className="v-text">{v.text || '（空）'}</span>
            {v.instruction && (v.source === 'ai_revise' || v.source === 'agent') && (
              <span className="v-instruction">意见：{v.instruction}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

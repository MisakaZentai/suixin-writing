/** 某块之后有待确认的新内容（agent 插的图、新写的段落、没看完的续写）：在这里给个入口 */
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { pendingIndex } from '../lib/doc'
import { isImageText } from '../lib/images'
import { IconSparkles } from './icons'

export function PendingInsertLink({ afterId }: { afterId: string }) {
  const id = useProjectStore((s) => (s.data ? pendingIndex(s.data.suggestions).insertAfter.get(afterId) ?? null : null))
  const label = useProjectStore((s) => {
    const sg = id ? s.data?.suggestions.find((x) => x.id === id) : undefined
    if (!sg) return ''
    const what = sg.proposed.split(/\n{2,}/).some(isImageText) ? '插入图片' : '新写了内容'
    return `${sg.author?.name ?? 'AI'} 想在下面${what}，点击查看`
  })
  // 正在看这一条时不重复显示
  const open = useUIStore((s) => s.diff?.suggestionId === id)
  if (!id || open) return null
  return (
    <span className="pending-inline">
      <button
        className="pending-link"
        onClick={(e) => {
          e.stopPropagation()
          useUIStore.getState().openDiff(id)
        }}
      >
        <IconSparkles size={12} />
        {label}
      </button>
    </span>
  )
}

/** 划选段内文字后浮出的小栏：把这段文字交给 AI，或者直接加 Markdown 格式 */
import { useUIStore } from '../store/uiStore'
import { useProjectStore } from '../store/projectStore'
import { getBlock } from '../lib/doc'
import { applyEdit } from '../lib/md'
import { IconSparkles } from './icons'
import { FormatButtons, editFor, type FormatAction } from './MdEditing'

/** 阅读时给选中的文字加格式：作为作者自己的修改写入（进版本历史，可撤销） */
function formatSelection(action: FormatAction): void {
  const ui = useUIStore.getState()
  const r = ui.textRange
  const data = useProjectStore.getState().data
  const block = r && data ? getBlock(data, r.blockId) : undefined
  if (!r || !block) return
  const edit = editFor(block.text, r.start, r.end, action)
  useProjectStore.getState().editBlock(r.blockId, applyEdit(block.text, edit), 'manual')
  useUIStore.setState({ textRange: null })
  window.getSelection()?.removeAllRanges()
  // 链接：直接进入编辑，光标停在地址后面接着输入
  if (action === 'link') ui.beginEdit(r.blockId, edit.selEnd)
}

export function SelectionBubble() {
  const range = useUIStore((s) => (s.aiPrompt || s.stream || s.diff || s.editing ? null : s.textRange))
  if (!range) return null
  const top = Math.max(56, range.rect.top - 74)
  const left = Math.min(window.innerWidth - 372, Math.max(8, range.rect.left + range.rect.width / 2 - 180))
  return (
    <div className="selection-bubble" style={{ top, left }} onMouseDown={(e) => e.preventDefault()}>
      <div className="bubble-row">
        <button className="tool-btn" onClick={() => useUIStore.getState().openAIPrompt()}>
          <IconSparkles />
          AI 改选中的文字
          <span className="kbd">空格</span>
        </button>
      </div>
      <div className="bubble-row" role="toolbar" aria-label="格式">
        <FormatButtons onAction={formatSelection} />
      </div>
    </div>
  )
}

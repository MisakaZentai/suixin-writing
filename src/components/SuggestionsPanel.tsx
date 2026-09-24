/**
 * 待办面板（spec F5 对齐检查 / F4 未决 diff）。
 * 两来源：AI 修改 diff（查看/重试）与对齐建议（转为修改/忽略）。
 */
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { IconX } from './icons'

export function SuggestionsPanel() {
  const setSuggestionsOpen = useUIStore((s) => s.setSuggestionsOpen)
  const openDiff = useUIStore((s) => s.openDiff)
  const requestLocate = useUIStore((s) => s.requestLocate)
  const setActive = useUIStore((s) => s.setActive)
  const retrySuggestion = useUIStore((s) => s.retrySuggestion)
  const data = useProjectStore((s) => s.data)

  if (!data) return null
  const pending = data.suggestions.filter((s) => s.state === 'pending')

  const blockKeyOf = (blockId: string): string | null => {
    const block = data.blocks.find((b) => b.id === blockId)
    if (!block) return null
    return `p:${block.paragraphId}`
  }

  const locateAndOpen = (suggestionId: string, blockId: string) => {
    const key = blockKeyOf(blockId)
    if (key) {
      requestLocate(key)
      setActive(key)
    }
    openDiff(suggestionId)
  }

  return (
    <aside className="suggestions-panel">
      <div className="suggestions-header">
        <span>待办 {pending.length > 0 && `(${pending.length})`}</span>
        <button
          className="icon-btn"
          onClick={() => setSuggestionsOpen(false)}
          title="关闭"
          aria-label="关闭"
        >
          <IconX />
        </button>
      </div>
      <div className="suggestions-list">
        {pending.length === 0 ? (
          <div className="suggestions-empty">
            暂无待办。
            <br />
            AI 的产出会先进入这里与块内 diff，确认后才生效。
          </div>
        ) : (
          pending.map((s) => {
            const block = data.blocks.find((b) => b.id === s.blockId)
            return (
              <div key={s.id} className="suggestion-card">
                <span className={`kind${s.kind === 'alignment' ? ' alignment' : ''}`}>
                  {s.kind === 'alignment' ? '对齐建议' : 'AI 修改'}
                </span>
                {s.instruction && (
                  <span className="instruction">意见：{s.instruction}</span>
                )}
                <span className="text">
                  {block?.text
                    ? block.text.length > 80
                      ? `${block.text.slice(0, 80)}…`
                      : block.text
                    : '（块已不存在）'}
                </span>
                <div className="actions">
                  {s.kind === 'ai_diff' ? (
                    <button
                      className="btn btn-primary"
                      onClick={() => locateAndOpen(s.id, s.blockId)}
                    >
                      查看 diff
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary"
                      onClick={() => void retrySuggestion(s.id)}
                    >
                      转为修改
                    </button>
                  )}
                  <button
                    className="btn btn-secondary"
                    onClick={() =>
                      useProjectStore.getState().dismissSuggestion(s.id)
                    }
                  >
                    忽略
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}

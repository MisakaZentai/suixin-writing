/**
 * AI 划分章节的提案：每个标题插在哪一段之前、什么层级、叫什么，
 * 作者可以取消勾选、改名、调层级，确认后才插入正文。
 */
import { useUIStore, type OutlineProposal } from '../store/uiStore'
import { applyOutlineProposal } from '../store/aiActions'
import { IconX } from './icons'

export function OutlineProposalModal({ proposal }: { proposal: OutlineProposal }) {
  const set = (p: OutlineProposal) => useUIStore.getState().setOutlineProposal(p)
  const close = () => useUIStore.getState().setOutlineProposal(null)
  const update = (i: number, patch: Partial<OutlineProposal['items'][number]>) =>
    set({ ...proposal, items: proposal.items.map((it, k) => (k === i ? { ...it, ...patch } : it)) })
  const count = proposal.items.filter((i) => i.include && i.title.trim()).length

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="modal proposal-modal" role="dialog" aria-label="AI 建议的章节">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>
            AI 建议的章节
          </div>
          <button className="icon-btn" onClick={close} title="取消（Esc）" aria-label="关闭">
            <IconX />
          </button>
        </div>
        <p className="modal-desc">勾选要插入的标题，可以直接改名、调层级。插入后仍可撤销。</p>
        <div className="proposal-list">
          {proposal.items.map((item, i) => (
            <div key={`${item.beforeId}-${i}`} className={`proposal-row${item.include ? '' : ' off'}`}>
              <input
                type="checkbox"
                checked={item.include}
                aria-label={`插入「${item.title}」`}
                onChange={(e) => update(i, { include: e.target.checked })}
              />
              <select
                className="input"
                value={item.level}
                aria-label="层级"
                onChange={(e) => update(i, { level: Number(e.target.value) })}
              >
                <option value={2}>章</option>
                <option value={3}>节</option>
                <option value={4}>小节</option>
              </select>
              <div className="proposal-main" style={{ paddingLeft: (item.level - 2) * 14 }}>
                <input
                  className="input"
                  value={item.title}
                  aria-label="标题"
                  onChange={(e) => update(i, { title: e.target.value })}
                />
                <span className="proposal-where">插在「{item.snippet}…」之前</span>
              </div>
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={close}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!count} onClick={applyOutlineProposal}>
            插入 {count} 个标题
          </button>
        </div>
      </div>
    </div>
  )
}

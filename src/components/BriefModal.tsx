/**
 * 写作设定：这篇文稿写给谁、什么语气、有什么忌讳。
 * 随每次 AI 请求一起发送，让所有修改保持同一种声音。
 */
import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { IconX } from './icons'

const EXAMPLE = '例如：\n读者是刚入行的产品经理，语气平实克制，少用形容词；\n不用"赋能""抓手"这类词；人名、数据不许改。'

export function BriefModal() {
  const brief = useProjectStore((s) => s.data?.brief ?? '')
  const [draft, setDraft] = useState(brief)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])

  const close = () => {
    if (draft !== brief) useProjectStore.getState().setBrief(draft.trim())
    useUIStore.getState().setBriefOpen(false)
  }

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="modal" role="dialog" aria-label="写作设定">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>
            写作设定
          </div>
          <button className="icon-btn" onClick={close} title="完成（Esc）" aria-label="关闭">
            <IconX />
          </button>
        </div>
        <p className="modal-desc">这篇文稿的读者、语气与禁忌。每次让 AI 修改时都会一并告诉它。</p>
        <textarea
          ref={ref}
          className="modal-textarea"
          value={draft}
          placeholder={EXAMPLE}
          aria-label="写作设定"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              close()
            }
          }}
        />
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={close}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * agent 在线请求"直接修改"权限：作者当场决定。
 * 默认焦点在"拒绝"，Esc 也是拒绝——授权必须是明确的一次点击。
 */
import { useEffect, useRef } from 'react'
import { useBridgeStore } from '../store/bridgeStore'

export function AccessRequestDialog() {
  const req = useBridgeStore((s) => s.accessRequests[0])
  const denyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!req) return
    denyRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      useBridgeStore.getState().answerAccess(req.id, false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req])

  if (!req) return null
  const answer = (granted: boolean) => useBridgeStore.getState().answerAccess(req.id, granted)
  return (
    <div className="modal-mask">
      <div className="modal access-request" role="alertdialog" aria-label="授权请求" aria-describedby="access-request-desc">
        <div className="modal-title">
          <span className="agent-badge">{req.agent}</span> 请求直接修改
        </div>
        <p className="modal-desc" id="access-request-desc">
          允许后，{req.agent} 可以直接改《{req.title}》的正文与结构（改标题、移动章节等），不再逐条等你确认。
          每处改动都署名、记入版本历史，可以撤销；随时可在「AI → Agent 访问」里收回。
        </p>
        {req.reason && <blockquote className="access-reason">{req.reason}</blockquote>}
        <div className="modal-footer">
          <button ref={denyRef} className="btn btn-secondary" onClick={() => answer(false)}>
            拒绝
          </button>
          <button className="btn btn-primary" onClick={() => answer(true)}>
            允许直接修改
          </button>
        </div>
      </div>
    </div>
  )
}

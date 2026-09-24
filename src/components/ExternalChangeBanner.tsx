/**
 * 绑定文件在外部（多半是 agent）被改了正文，而这边也有没保存的改动：
 * 暂停写入，请作者决定保留哪一份。选了哪份，另一份都还能用撤销找回（载入外部版本时）。
 */
import { useDocsStore } from '../store/docsStore'

export function ExternalChangeBanner() {
  const external = useDocsStore((s) => s.external)
  if (!external) return null
  const resolve = useDocsStore.getState().resolveExternal
  return (
    <div className="external-banner" role="alert">
      <span>文件在外部被修改（{external.summary}），这边的改动暂未保存。</span>
      <span style={{ flex: 1 }} />
      <button className="btn btn-secondary" onClick={() => resolve('mine')} title="用这边的版本覆盖文件">
        保留我的版本
      </button>
      <button className="btn btn-primary" onClick={() => resolve('theirs')} title="载入外部版本，Ctrl+Z 可找回这边的改动">
        载入外部版本
      </button>
    </div>
  )
}

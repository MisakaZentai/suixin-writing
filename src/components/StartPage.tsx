/**
 * 启动页：新建 / 打开 / 粘贴导入 + 最近文稿。
 * 文件拖放与 Ctrl+V 粘贴由 App 在整个窗口范围处理。
 */
import { useState } from 'react'
import { useDocsStore } from '../store/docsStore'
import { useUIStore } from '../store/uiStore'
import { SAMPLE_TEXT } from '../lib/sample'
import type { DocEntry } from '../lib/library'
import { relativeTime } from './VersionPopover'
import { IconPen, IconTrash, IconUpload } from './icons'

export function StartPage() {
  const entries = useDocsStore((s) => s.entries)
  const ready = useDocsStore((s) => s.ready)
  const docs = () => useDocsStore.getState()

  const startBlank = async () => {
    const first = await docs().newBlank()
    if (first) useUIStore.getState().beginEdit(first)
  }

  return (
    <div className="start">
      <div className="start-inner">
        <h1 className="start-brand">随心写作</h1>
        <p className="start-sub">写作与改稿。AI 只提修改建议，由你逐处拍板。</p>
        <div className="start-actions">
          <button className="btn btn-primary btn-lg" onClick={() => void startBlank()}>
            <IconPen />
            从空白开始写
          </button>
          <button className="btn btn-secondary btn-lg" onClick={() => void docs().pickAndOpen()}>
            <IconUpload />
            打开文件…
          </button>
          <button className="btn btn-secondary btn-lg" onClick={() => useUIStore.getState().setImportOpen(true)}>
            粘贴导入…
          </button>
        </div>
        <p className="start-hint">也可以直接按 Ctrl+V 粘贴，或把 .md / .txt / 工程文件拖进窗口。</p>

        <section className="recent" aria-label="最近文稿">
          <div className="recent-title">最近文稿</div>
          {ready && entries.length === 0 && (
            <div className="recent-empty">还没有文稿。所有文稿都会自动保存在这里。</div>
          )}
          {entries.map((e) => (
            <RecentRow key={e.id} entry={e} />
          ))}
        </section>

        <p className="start-sample">
          想先看看效果？
          <button
            className="link-btn"
            onClick={() => void docs().importText(SAMPLE_TEXT)}
          >
            载入示例《没有雨的城市》
          </button>
        </p>
      </div>
    </div>
  )
}

function RecentRow({ entry }: { entry: DocEntry }) {
  const [confirming, setConfirming] = useState(false)
  const docs = () => useDocsStore.getState()
  return (
    <div className="recent-row">
      <button className="recent-open" onClick={() => void docs().openEntry(entry.id)}>
        <span className="recent-name">{entry.title || '未命名文稿'}</span>
        <span className="recent-meta">
          {relativeTime(entry.updatedAt)} · {entry.chars.toLocaleString()} 字
          {entry.path ? ` · ${entry.path}` : ''}
        </span>
      </button>
      {confirming ? (
        <span className="recent-confirm">
          {entry.path ? '从列表移除（磁盘上的文件保留）？' : '删除这篇文稿？'}
          <button className="btn btn-plain btn-danger" onClick={() => void docs().removeEntry(entry.id)}>
            {entry.path ? '移除' : '删除'}
          </button>
          <button className="btn btn-plain" onClick={() => setConfirming(false)}>
            取消
          </button>
        </span>
      ) : (
        <button
          className="icon-btn recent-remove"
          title={entry.path ? '从列表移除' : '删除'}
          aria-label={`删除 ${entry.title}`}
          onClick={() => setConfirming(true)}
        >
          <IconTrash size={13} />
        </button>
      )}
    </div>
  )
}

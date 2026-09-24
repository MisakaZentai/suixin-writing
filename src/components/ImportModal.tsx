/**
 * 粘贴导入：永远导入为一篇新文稿，当前文稿不受影响。
 * 粘贴内容是工程文件（JSON）时直接打开。
 */
import { useEffect, useRef, useState } from 'react'
import { useUIStore } from '../store/uiStore'
import { useDocsStore } from '../store/docsStore'
import { IconUpload, IconX } from './icons'

export function ImportModal() {
  const setImportOpen = useUIStore((s) => s.setImportOpen)
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const submit = async () => {
    const t = text.trim()
    if (!t) return
    setImportOpen(false)
    try {
      if (t.startsWith('{')) await useDocsStore.getState().openProjectText(t)
      else await useDocsStore.getState().importText(t)
    } catch (e) {
      useUIStore.getState().pushToast({ kind: 'error', text: `导入失败：${(e as Error).message}`, duration: 8000 })
    }
  }

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setImportOpen(false)
      }}
    >
      <div className="modal" role="dialog" aria-label="粘贴导入">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>
            粘贴导入
          </div>
          <button className="icon-btn" onClick={() => setImportOpen(false)} title="关闭（Esc）" aria-label="关闭">
            <IconX />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          className="modal-textarea"
          style={{ marginTop: 16 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder={'粘贴正文或 Markdown…\n\n- # 标题会成为大纲\n- 空行分段；没有空行的文本按一行一段\n- 会导入为一篇新文稿，当前文稿不受影响'}
          spellCheck={false}
          aria-label="要导入的内容"
        />
        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <button
            className="btn btn-plain"
            onClick={() => {
              setImportOpen(false)
              void useDocsStore.getState().pickAndOpen()
            }}
          >
            <IconUpload />
            改为打开文件…
          </button>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {text.length > 0 && `${text.length.toLocaleString()} 字`}
            </span>
            <button className="btn btn-secondary" onClick={() => setImportOpen(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={!text.trim()}>
              导入为新文稿
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

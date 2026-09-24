/**
 * 导入弹层：已有文档时的粘贴 / 文件导入（会替换当前文稿）。
 * 粘贴内容为工程 JSON（ai-writer/project@1）时直接读档。
 */
import { useEffect, useRef, useState } from 'react'
import { useUIStore } from '../store/uiStore'
import { openTextFile } from '../lib/platform'
import { IconUpload, IconX } from './icons'

interface Props {
  onImportText: (text: string) => void
  onImportJson: (text: string) => void
}

export function ImportModal({ onImportText, onImportJson }: Props) {
  const setImportOpen = useUIStore((s) => s.setImportOpen)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const t = window.setTimeout(() => textareaRef.current?.focus(), 120)
    return () => window.clearTimeout(t)
  }, [])

  const submit = () => {
    const t = text.trim()
    if (!t) {
      setError('请先粘贴一些内容')
      return
    }
    if (t.startsWith('{')) {
      // 工程 JSON：直接读档
      onImportJson(t)
      return
    }
    onImportText(t)
  }

  const pickFile = async () => {
    const file = await openTextFile()
    if (!file) return
    const content = file.text
    if (file.name.toLowerCase().endsWith('.json')) onImportJson(content)
    else {
      setText(content)
      setError(null)
    }
  }

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setImportOpen(false)
      }}
    >
      <div className="modal">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div className="modal-title" style={{ marginBottom: 0 }}>
            导入文稿
          </div>
          <button
            className="icon-btn"
            onClick={() => setImportOpen(false)}
            title="关闭（Esc）"
            aria-label="关闭"
          >
            <IconX />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          className="modal-textarea"
          style={{ marginTop: 16 }}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
          placeholder={
            '粘贴正文或 Markdown 文档…\n\n- Markdown 的 # 标题会成为大纲节点\n- 正文自动按段落、句子拆块\n- 粘贴 ai-writer 工程 JSON 则直接读档'
          }
          spellCheck={false}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 12,
          }}
        >
          <button className="btn btn-plain" onClick={() => void pickFile()}>
            <IconUpload />
            选择文件…
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {text.length > 0 && `${text.length} 字`}
          </span>
        </div>
        {error && (
          <div className="settings-error" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}
        <div className="modal-footer">
          <button
            className="btn btn-secondary"
            onClick={() => setImportOpen(false)}
          >
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={!text.trim()}
          >
            导入并拆块
          </button>
        </div>
      </div>
    </div>
  )
}

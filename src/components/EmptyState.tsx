/**
 * 空状态稿纸（design §5.7「空白的邀请」）。
 * 粘贴提示 / 拖放 .md .txt / 示例文稿 / 崩溃恢复入口（spec F1/F6）。
 */
import { useEffect, useState } from 'react'
import { SAMPLE_TEXT } from '../lib/importer'
import {
  clearRecovery,
  loadRecovery,
  openTextFile,
} from '../lib/platform'
import { IconUpload } from './icons'

interface Props {
  onImportText: (text: string) => void
  onImportJson: (text: string) => void
}

export function EmptyState({ onImportText, onImportJson }: Props) {
  const [dropping, setDropping] = useState(false)
  const [recoveryAt, setRecoveryAt] = useState<string | null>(null)
  /* 稿纸入场动画只在会话首次载入播放，之后回到空状态不再重复 */
  const [firstShow] = useState(
    () => !sessionStorage.getItem('ai-writer:paper-shown')
  )

  useEffect(() => {
    sessionStorage.setItem('ai-writer:paper-shown', '1')
  }, [])

  useEffect(() => {
    void loadRecovery().then((r) => {
      if (r && r.content.trim()) setRecoveryAt(r.at)
    })
  }, [])

  const readText = (name: string, text: string) => {
    if (name.toLowerCase().endsWith('.json')) onImportJson(text)
    else onImportText(text)
  }

  const readFile = async (file: File) => readText(file.name, await file.text())

  const restore = async () => {
    const r = await loadRecovery()
    if (!r) return
    try {
      onImportJson(r.content)
      setRecoveryAt(null)
    } catch {
      /* 打开失败时保留恢复入口 */
    }
  }

  const discard = async () => {
    await clearRecovery()
    setRecoveryAt(null)
  }

  return (
    <div className="empty-holder">
      <div
        className={`paper${dropping ? ' dropping' : ''}${firstShow ? '' : ' no-anim'}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDropping(false)
          const file = e.dataTransfer.files[0]
          if (file) void readFile(file)
        }}
      >
        <div className="paper-title">把文稿放到这张纸上</div>
        <p className="paper-sub">
          Ctrl+V 粘贴，或把 .md / .txt 文件拖进来。
          <br />
          粘贴即刻拆块——Markdown 标题自动成为大纲。
        </p>
        <div className="paper-actions">
          <button
            className="btn btn-secondary"
            onClick={() =>
              void openTextFile().then((f) => {
                if (f) readText(f.name, f.text)
              })
            }
          >
            <IconUpload />
            选择文件…
          </button>
          <div className="paper-sample">
            没有合适的文稿？
            <button
              className="paper-sample-link"
              onClick={() => onImportText(SAMPLE_TEXT)}
            >
              载入示例《没有雨的城市》
            </button>
          </div>
        </div>
        {recoveryAt && (
          <div
            style={{
              marginTop: 16,
              paddingTop: 16,
              borderTop: '1px solid var(--separator)',
              fontSize: 12,
              color: 'var(--text-secondary)',
              lineHeight: 1.8,
            }}
          >
            发现自动保存的文稿
            {recoveryAt ? `（${new Date(recoveryAt).toLocaleString()}）` : ''}
            <br />
            <button className="paper-sample-link" onClick={() => void restore()}>
              恢复它
            </button>
            {' · '}
            <button className="paper-sample-link" onClick={() => void discard()}>
              丢弃
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

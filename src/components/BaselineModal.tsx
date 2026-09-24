/**
 * 用作者自己的文字建立 AI 味基线：作者也常用的写法有豁免额度，从来不用的一出现就重罚。
 * 来源可以是文稿库里的文稿，也可以是本机的 .txt / .md 文件。
 * 先预检来源本身的 AI 味——"质量基准"和"AI 味病灶"并不互斥，AI 改过很多的稿子会把套路也算成你的习惯。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDocsStore } from '../store/docsStore'
import { useBaselineStore } from '../store/baselineStore'
import { useUIStore } from '../store/uiStore'
import { library } from '../lib/library'
import { pickTextFiles } from '../lib/platform'
import { analyzeDocument, countChars, MIN_BASELINE_CHARS, sourceParagraphs } from '../lib/flavor'
import { IconX } from './icons'

interface Source {
  name: string
  text: string
}

export function BaselineModal({ onClose }: { onClose: () => void }) {
  const entries = useDocsStore((s) => s.entries)
  const baselines = useBaselineStore((s) => s.store.baselines)
  const existing = baselines.map((b) => b.name)
  const [name, setName] = useState(existing.length ? '' : '我的文风')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [files, setFiles] = useState<Source[]>([])
  const [makeDefault, setMakeDefault] = useState(true)
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])

  const chars = useMemo(
    () =>
      files.reduce((n, f) => n + countChars(f.text), 0) +
      entries.filter((e) => picked.has(e.id)).reduce((n, e) => n + e.chars, 0),
    [files, picked, entries]
  )
  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const trimmed = name.trim()
  const canBuild = trimmed && trimmed !== '内置' && (files.length || picked.size) && !busy

  const gather = async (): Promise<Source[]> => {
    const docs = await Promise.all(
      entries
        .filter((e) => picked.has(e.id))
        .map(async (e) => ({ name: `${e.title}.suixin.json`, text: (await library.read(e.id)) ?? '' }))
    )
    return [...files, ...docs.filter((d) => d.text)]
  }

  const build = async () => {
    if (!canBuild) return
    setBusy(true)
    try {
      const sources = await gather()
      if (!warning) {
        // 预检：来源本身 AI 味很重时先提醒一次
        const paras = sources.flatMap((s) => sourceParagraphs(s.name, s.text))
        const check = analyzeDocument(
          paras.map((text, i) => ({ id: `s${i}`, type: 'paragraph', text })),
          { baseline: null }
        )
        if ((check.index ?? 0) >= 35) {
          setWarning(
            `这些文字本身的 AI 味指数是 ${check.index}（${check.level}），主要是${check.rules
              .slice(0, 3)
              .map((r) => r.name)
              .join('、')}。用它们做基线，会把这些套路当成你的习惯。`
          )
          return
        }
      }
      await useBaselineStore.getState().build(trimmed, sources, makeDefault)
      useUIStore.getState().pushToast({ kind: 'success', text: `已建立基线「${trimmed}」（${chars} 字）` })
      onClose()
    } catch (e) {
      useUIStore.getState().pushToast({ kind: 'error', text: `建立基线失败：${(e as Error)?.message ?? e}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="modal baseline-modal" role="dialog" aria-label="建立我的基线">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>
            建立我的基线
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
            <IconX />
          </button>
        </div>
        <p className="modal-desc">
          选几篇<b>你自己写的</b>文字。你也常用的写法会有豁免额度，你从来不用的套路一出现就算超标。
          至少 {MIN_BASELINE_CHARS} 字，越多越准。
        </p>
        <label className="baseline-field">
          <span>名字</span>
          <input
            ref={nameRef}
            className="baseline-name"
            value={name}
            placeholder="比如笔名"
            onChange={(e) => {
              setName(e.target.value)
              setWarning(null)
            }}
            aria-label="基线名字"
          />
        </label>
        {existing.includes(trimmed) && <div className="baseline-hint">已有同名基线，建立后会替换它。</div>}

        <div className="baseline-sources" aria-label="来源">
          {entries.map((e) => (
            <label key={e.id} className="baseline-source">
              <input
                type="checkbox"
                checked={picked.has(e.id)}
                onChange={() => {
                  toggle(e.id)
                  setWarning(null)
                }}
              />
              <span className="baseline-source-title">{e.title || '未命名'}</span>
              <span className="baseline-source-chars">{e.chars} 字</span>
            </label>
          ))}
          {files.map((f, i) => (
            <div key={`${f.name}${i}`} className="baseline-source">
              <span className="baseline-source-title">{f.name}</span>
              <span className="baseline-source-chars">{countChars(f.text)} 字</span>
              <button
                className="icon-btn"
                aria-label={`移除 ${f.name}`}
                onClick={() => {
                  setFiles(files.filter((_, j) => j !== i))
                  setWarning(null)
                }}
              >
                <IconX size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="link-btn"
          onClick={async () => {
            const more = await pickTextFiles()
            if (more.length) {
              setFiles([...files, ...more])
              setWarning(null)
            }
          }}
        >
          从本机文件添加（.txt / .md / 工程文件）…
        </button>

        <label className="baseline-default">
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
          设为默认基线（没有单独选择的文稿都用它）
        </label>
        {warning && <div className="baseline-warning">{warning}</div>}
        {chars > 0 && chars < MIN_BASELINE_CHARS && <div className="baseline-hint">现在只有 {chars} 字，统计可能不准。</div>}

        <div className="modal-footer">
          <span className="baseline-total">{chars ? `共 ${chars} 字` : ''}</span>
          <button className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!canBuild} onClick={() => void build()}>
            {warning ? '仍然建立' : busy ? '统计中…' : '建立'}
          </button>
        </div>
      </div>
    </div>
  )
}

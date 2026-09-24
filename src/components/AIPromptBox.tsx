/**
 * 统一的 AI 指令框：写下要求（留空 = 润色），或点一个快捷指令。
 * 没配置 AI 服务时就地展开配置，填完 Key 就能继续，不用跳去设置页。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useUIStore, type AIScope } from '../store/uiStore'
import { useAIConfigStore } from '../store/aiConfigStore'
import { chipsFor, recentInstructions, submitAIPrompt } from '../store/aiActions'
import { PROVIDERS, providerById } from '../lib/aiConfig'
import { IconSparkles, IconX } from './icons'
import { isImeKey } from '../lib/ime'
import { handPromptToAgent } from '../store/agentTasks'

export function AIPromptBox({ scope }: { scope: AIScope }) {
  const draft = useUIStore((s) => s.aiPrompt?.draft ?? '')
  const keyPresent = useAIConfigStore((s) => s.keyPresent)
  const ref = useRef<HTMLTextAreaElement>(null)
  const chips = chipsFor(scope)
  const [recents] = useState(recentInstructions)

  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(140, el.scrollHeight)}px`
  }, [draft])

  const close = () => useUIStore.getState().closeAIPrompt()
  const emptyLabel = scope.kind === 'section' && !scope.blockIds.length ? '写这一节' : '润色'

  return (
    <div
      className="ai-prompt"
      role="dialog"
      aria-label="AI 指令"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="ai-prompt-head">
        <IconSparkles size={12} />
        <span className="ai-prompt-scope">
          AI · {scope.label}
          {scope.preview && <span className="ai-prompt-preview">「{truncate(scope.preview, 30)}」</span>}
        </span>
        <button className="icon-btn" onClick={close} title="关闭（Esc）" aria-label="关闭">
          <IconX size={12} />
        </button>
      </div>

      {!keyPresent && <InlineKeySetup />}

      <textarea
        ref={ref}
        className="ai-prompt-input"
        rows={1}
        value={draft}
        placeholder={`告诉 AI 怎么改，例如"压到 50 字以内"；留空直接回车 = ${emptyLabel}`}
        aria-label="给 AI 的要求"
        onChange={(e) => useUIStore.getState().updatePromptDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isImeKey(e.nativeEvent)) return
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            e.stopPropagation()
            if (keyPresent) void submitAIPrompt()
          }
        }}
      />

      <div className="ai-chips">
        {chips.map((c) => (
          <button
            key={c.label}
            className="ai-chip"
            disabled={!keyPresent}
            title={c.instruction ?? (c.mode === 'continue' ? '接着往下写一段' : '保持原意，润色表达')}
            onClick={() => void submitAIPrompt(c)}
          >
            {c.label}
          </button>
        ))}
        {recents.map((r) => (
          <button
            key={r}
            className="ai-chip recent"
            title={r}
            onClick={() => useUIStore.getState().updatePromptDraft(r)}
          >
            {truncate(r, 14)}
          </button>
        ))}
      </div>

      <div className="ai-prompt-foot">
        <span>结果会先以对照形式给你逐处确认</span>
        <button className="link-btn" onClick={() => useUIStore.getState().setBriefOpen(true)}>
          写作设定…
        </button>
        <button
          className="btn btn-secondary"
          disabled={!draft.trim()}
          title={draft.trim() ? '不用内置 AI，交给 Codex、Claude Code 等外部 agent 处理' : '先写下要求'}
          onClick={() => handPromptToAgent()}
        >
          交给 Agent
        </button>
        <button className="btn btn-primary" disabled={!keyPresent} onClick={() => void submitAIPrompt()}>
          {draft.trim() ? '发送' : emptyLabel}
          <span className="kbd on-accent">↵</span>
        </button>
      </div>
    </div>
  )
}

/** 第一次用 AI 时的就地配置：选服务商 + 粘贴 Key */
function InlineKeySetup() {
  const config = useAIConfigStore((s) => s.config)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void useAIConfigStore.getState().refreshKeyPresence()
  }, [])
  const save = async () => {
    if (!key.trim()) return
    setSaving(true)
    await useAIConfigStore.getState().saveKey(key)
    setSaving(false)
  }
  return (
    <div className="inline-setup">
      <div className="inline-setup-title">先接入一个 AI 服务（只需一次）</div>
      <div className="inline-setup-row">
        <select
          className="input"
          value={config.provider}
          onChange={(e) => void useAIConfigStore.getState().selectProvider(e.target.value)}
          aria-label="服务商"
        >
          {PROVIDERS.filter((p) => p.id !== 'custom').map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {config.provider === 'custom' && <option value="custom">自定义</option>}
        </select>
        <input
          className="input"
          type="password"
          value={key}
          placeholder={`粘贴 ${providerById(config.provider).name} 的 API Key`}
          aria-label="API Key"
          autoComplete="off"
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              void save()
            }
          }}
        />
        <button className="btn btn-primary" disabled={!key.trim() || saving} onClick={() => void save()}>
          保存
        </button>
      </div>
      <div className="inline-setup-hint">
        Key 只保存在本机，只会发给所选服务。更多选项在
        <button className="link-btn" onClick={() => useUIStore.getState().setSettingsOpen(true)}>
          设置
        </button>
        里。
      </div>
    </div>
  )
}

/** AI 请求失败：就地显示，可重试，手动关闭 */
export function AIErrorStrip({ anchorId }: { anchorId: string }) {
  const error = useUIStore((s) => (s.aiError?.anchorId === anchorId ? s.aiError : null))
  if (!error) return null
  const notConfigured = error.message === '还没有配置 AI 服务'
  return (
    <div className="ai-error" role="alert" onClick={(e) => e.stopPropagation()}>
      <span className="ai-error-text">{notConfigured ? error.message : `AI 请求失败：${error.message}`}</span>
      {error.retry && (
        <button
          className="btn btn-plain"
          onClick={() => {
            useUIStore.getState().setAIError(null)
            error.retry?.()
          }}
        >
          {notConfigured ? '去设置' : '重试'}
        </button>
      )}
      <button
        className="icon-btn"
        onClick={() => useUIStore.getState().setAIError(null)}
        title="关闭"
        aria-label="关闭错误提示"
      >
        <IconX size={12} />
      </button>
    </div>
  )
}

function truncate(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ')
  return t.length > n ? `${t.slice(0, n)}…` : t
}

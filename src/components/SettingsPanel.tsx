/**
 * 设置面板（右侧滑入）。
 * - AI 服务是应用级设置：选服务商 → 粘贴 Key → 自动测试，所有改动即时保存；
 * - Key 按服务商分别存入系统安全区（桌面版 keyring，浏览器模式降级为 localStorage）；
 * - 接口地址与模型收在"高级"里，写作者只需要理解"风格"。
 */
import { useEffect, useState } from 'react'
import { useUIStore, type BodyFont, type Measure, type TextSize } from '../store/uiStore'
import { useAIConfigStore } from '../store/aiConfigStore'
import { PROVIDERS, STYLE_OPTIONS, providerById, type AIStyle } from '../lib/aiConfig'
import { testConnection } from '../lib/ai'
import { isTauri } from '../lib/platform'
import { SegmentedControl } from './SegmentedControl'
import { IconCheck, IconX } from './icons'

type ThemeChoice = 'system' | 'light' | 'dark'

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; msg: string }

export function SettingsPanel() {
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const theme = useUIStore((s) => s.theme)
  const setTheme = useUIStore((s) => s.setTheme)
  const bodyFont = useUIStore((s) => s.bodyFont)
  const markdown = useUIStore((s) => s.markdown)
  const textSize = useUIStore((s) => s.textSize)
  const measure = useUIStore((s) => s.measure)

  const config = useAIConfigStore((s) => s.config)
  const keyPresent = useAIConfigStore((s) => s.keyPresent)
  const selectProvider = useAIConfigStore((s) => s.selectProvider)
  const update = useAIConfigStore((s) => s.update)

  const [keyDraft, setKeyDraft] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const [advancedOpen, setAdvancedOpen] = useState(config.provider === 'custom')
  const preset = providerById(config.provider)

  useEffect(() => {
    void useAIConfigStore.getState().refreshKeyPresence()
  }, [])

  const runTest = async () => {
    setTest({ kind: 'testing' })
    const resolved = await useAIConfigStore.getState().resolve()
    if (!resolved) {
      setTest({
        kind: 'error',
        msg: config.baseURL.trim() ? '还没有保存 API Key' : '请先在"高级"里填写接口地址',
      })
      return
    }
    try {
      await testConnection(resolved)
      setTest({ kind: 'ok' })
    } catch (e) {
      setTest({ kind: 'error', msg: (e as Error).message || '未知错误' })
    }
  }

  const commitKey = async () => {
    if (!keyDraft.trim()) return
    await useAIConfigStore.getState().saveKey(keyDraft)
    setKeyDraft('')
    setShowKey(false)
    await runTest()
  }

  const pickProvider = async (id: string) => {
    setTest({ kind: 'idle' })
    setKeyDraft('')
    if (id === 'custom') setAdvancedOpen(true)
    await selectProvider(id)
  }

  return (
    <>
      <div
        className="settings-overlay"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setSettingsOpen(false)
        }}
      />
      <aside className="settings-panel" aria-label="设置">
        <div className="settings-header">
          <span>设置</span>
          <button
            className="icon-btn"
            onClick={() => setSettingsOpen(false)}
            title="关闭（Esc）"
            aria-label="关闭"
          >
            <IconX />
          </button>
        </div>
        <div className="settings-body">
          <section className="settings-section">
            <div className="settings-section-title">AI 服务</div>
            <div className="provider-grid" role="radiogroup" aria-label="服务商">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={config.provider === p.id}
                  className={`provider-option${config.provider === p.id ? ' selected' : ''}`}
                  onClick={() => void pickProvider(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="api-key-input">
                {preset.name} 的 API Key
              </label>
              <div className="settings-row">
                <input
                  id="api-key-input"
                  className="input"
                  type={showKey ? 'text' : 'password'}
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onBlur={() => void commitKey()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitKey()
                  }}
                  placeholder={keyPresent ? '已保存（粘贴新 Key 可替换）' : '粘贴 API Key，回车保存'}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  className="btn btn-plain"
                  onClick={() => setShowKey((v) => !v)}
                  disabled={!keyDraft}
                >
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </div>

            <div className="settings-row" style={{ gap: 8 }}>
              <button
                className="btn btn-secondary"
                onClick={() => void runTest()}
                disabled={test.kind === 'testing'}
              >
                {test.kind === 'testing' ? '测试中…' : '测试连接'}
              </button>
              {keyPresent && (
                <button
                  className="btn btn-plain btn-danger"
                  onClick={() => {
                    setTest({ kind: 'idle' })
                    void useAIConfigStore.getState().deleteKey()
                  }}
                >
                  清除 Key
                </button>
              )}
            </div>
            {test.kind === 'ok' && (
              <div className="settings-status ok" role="status">
                <IconCheck size={12} /> 已连接 · {config.model || '默认模型'}
              </div>
            )}
            {test.kind === 'error' && (
              <div className="settings-status error" role="alert">
                <IconX size={12} /> {test.msg}
              </div>
            )}

            <div className="field">
              <span className="field-label">AI 风格</span>
              <SegmentedControl<AIStyle>
                value={config.style}
                items={STYLE_OPTIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
                onChange={(style) => update({ style })}
                ariaLabel="AI 风格"
              />
              <span className="settings-hint">
                {STYLE_OPTIONS.find((o) => o.value === config.style)?.hint}
              </span>
            </div>

            <details
              className="settings-advanced"
              open={advancedOpen}
              onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary>高级：接口地址与模型</summary>
              <div className="field">
                <label className="field-label" htmlFor="base-url-input">
                  接口地址（OpenAI 兼容）
                </label>
                <input
                  id="base-url-input"
                  className="input"
                  value={config.baseURL}
                  onChange={(e) => update({ baseURL: e.target.value })}
                  placeholder="https://example.com/v1"
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="model-input">
                  模型
                </label>
                <input
                  id="model-input"
                  className="input"
                  value={config.model}
                  onChange={(e) => update({ model: e.target.value })}
                  list="model-suggestions"
                  placeholder="模型名"
                  spellCheck={false}
                />
                <datalist id="model-suggestions">
                  {preset.models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
            </details>
          </section>

          <section className="settings-section">
            <div className="settings-section-title">外观</div>
            <span className="field-label">主题</span>
            <SegmentedControl<ThemeChoice>
              value={theme}
              items={[
                { value: 'system', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]}
              onChange={setTheme}
              ariaLabel="主题"
            />
            <div className="field">
              <span className="field-label">正文字体</span>
              <SegmentedControl<BodyFont>
                value={bodyFont}
                items={[
                  { value: 'serif', label: '宋体' },
                  { value: 'sans', label: '黑体' },
                  { value: 'kai', label: '楷体' },
                ]}
                onChange={(f) => useUIStore.getState().setBodyFont(f)}
                ariaLabel="正文字体"
              />
              <span className="settings-hint">
                {bodyFont === 'serif' ? '内置思源宋体，不依赖系统字体' : '使用系统自带的字体'}
              </span>
            </div>
            <div className="field">
              <span className="field-label">正文字号</span>
              <SegmentedControl<TextSize>
                value={textSize}
                items={[
                  { value: 'auto', label: '自动' },
                  { value: 's', label: '小' },
                  { value: 'm', label: '中' },
                  { value: 'l', label: '大' },
                  { value: 'xl', label: '特大' },
                ]}
                onChange={(t) => useUIStore.getState().setTextSize(t)}
                ariaLabel="正文字号"
              />
              <span className="settings-hint">
                {textSize === 'auto' ? '随窗口变化：窗口越宽，字越大' : '固定字号，不随窗口变化'}
              </span>
            </div>
            <div className="field">
              <span className="field-label">正文宽度</span>
              <SegmentedControl<Measure>
                value={measure}
                items={[
                  { value: 'normal', label: '适中' },
                  { value: 'wide', label: '宽' },
                  { value: 'full', label: '铺满' },
                ]}
                onChange={(m) => useUIStore.getState().setMeasure(m)}
                ariaLabel="正文宽度"
              />
              <span className="settings-hint">
                {measure === 'normal'
                  ? '每行约 40 字，读起来最舒服'
                  : measure === 'wide'
                    ? '每行约 52 字'
                    : '占满窗口，只留页边'}
              </span>
            </div>
            <div className="field">
              <span className="field-label">Markdown</span>
              <SegmentedControl<'on' | 'off'>
                value={markdown ? 'on' : 'off'}
                items={[
                  { value: 'on', label: '显示效果' },
                  { value: 'off', label: '显示源码' },
                ]}
                onChange={(v) => useUIStore.getState().setMarkdown(v === 'on')}
                ariaLabel="Markdown"
              />
              <span className="settings-hint">
                {markdown
                  ? '**加粗**、列表、引用等直接显示效果；编辑时标记变淡，选中文字可用格式浮条'
                  : '一律显示 Markdown 源码'}
              </span>
            </div>
          </section>

          <p className="settings-footnote">
            所有设置即时生效，与文稿无关。
            {isTauri
              ? 'Key 只保存在本机系统安全区，只会发送给上面选择的服务。'
              : '浏览器模式下 Key 保存在本机浏览器存储里（仅供开发调试），只会发送给上面选择的服务。'}
          </p>
        </div>
      </aside>
    </>
  )
}

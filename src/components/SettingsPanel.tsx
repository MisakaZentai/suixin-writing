/**
 * 设置面板（spec F7 / design §5.7 右侧滑入）。
 * API Key 经 secret 存系统安全区（Tauri keyring / 浏览器 localStorage 降级）。
 * 测试连接：loading → 绿 ✓ → 红✗ 错误 height-morph。
 */
import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { secret } from '../lib/platform'
import { testConnection, type AIConfig } from '../lib/ai'
import { IconCheck, IconMoon, IconSettings, IconSun, IconX } from './icons'

type ThemeChoice = 'system' | 'light' | 'dark'

export function SettingsPanel() {
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const theme = useUIStore((s) => s.theme)
  const setTheme = useUIStore((s) => s.setTheme)
  const refreshApiKeyPresence = useUIStore((s) => s.refreshApiKeyPresence)
  const pushToast = useUIStore((s) => s.pushToast)

  const data = useProjectStore((s) => s.data)
  const updateSettings = useProjectStore((s) => s.updateSettings)

  /* 本地表单状态：从工程 settings 初始化，编辑后写回工程 */
  const [baseURL, setBaseURL] = useState(data?.settings.baseURL ?? '')
  const [model, setModel] = useState(data?.settings.model ?? '')
  const [temperature, setTemperature] = useState(
    data?.settings.temperature ?? 0.7
  )
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<
    { ok: true } | { ok: false; msg: string } | null
  >(null)
  const [flashOk, setFlashOk] = useState(false)
  const keyInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!data) return
    setBaseURL(data.settings.baseURL)
    setModel(data.settings.model)
    setTemperature(data.settings.temperature)
  }, [data?.meta.updatedAt])

  useEffect(() => {
    void secret.get('apiKey').then((k) => {
      setHasKey(Boolean(k))
      useUIStore.setState({ apiKeyPresent: Boolean(k) })
    })
  }, [])

  const save = async () => {
    if (data) updateSettings({ baseURL, model, temperature })
    if (apiKey) {
      await secret.set('apiKey', apiKey)
      setHasKey(true)
      setApiKey('')
      void refreshApiKeyPresence()
    }
    setFlashOk(true)
    window.setTimeout(() => setFlashOk(false), 300)
    pushToast({ kind: 'success', text: '设置已保存' })
  }

  const deleteKey = async () => {
    await secret.del('apiKey')
    setHasKey(false)
    setApiKey('')
    void refreshApiKeyPresence()
    pushToast({ kind: 'info', text: 'API Key 已清除' })
  }

  const doTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const key = apiKey || (await secret.get('apiKey')) || ''
      if (!key) {
        setTestResult({ ok: false, msg: '未输入 API Key' })
        setTesting(false)
        return
      }
      const config: AIConfig = {
        baseURL,
        apiKey: key,
        model,
        temperature,
      }
      await testConnection(config)
      setTestResult({ ok: true })
    } catch (e) {
      setTestResult({ ok: false, msg: (e as Error).message || '未知错误' })
    }
    setTesting(false)
  }

  return (
    <>
      <div
        className="settings-overlay"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setSettingsOpen(false)
        }}
      />
      <aside className="settings-panel">
        <div className="settings-header">
          <span>设置</span>
          <button
            className="icon-btn"
            onClick={() => setSettingsOpen(false)}
            title="关闭"
            aria-label="关闭"
          >
            <IconX />
          </button>
        </div>
        <div className="settings-body">
          {/* AI 配置 */}
          <div className="settings-section">
            <div className="settings-section-title">AI 接入</div>
            <div className="field">
              <label className="field-label">API 端点 (baseURL)</label>
              <input
                className="input"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                placeholder="https://api.deepseek.com/v1"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label className="field-label">模型名</label>
              <input
                className="input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="deepseek-chat"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label className="field-label">温度 (0–2)</label>
              <input
                className="input"
                type="number"
                step={0.1}
                min={0}
                max={2}
                value={temperature}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  if (!Number.isNaN(v)) setTemperature(v)
                }}
              />
            </div>
          </div>

          {/* API Key（系统安全存储） */}
          <div className="settings-section">
            <div className="settings-section-title">API Key（系统安全存储）</div>
            <div className="settings-row">
              <input
                ref={keyInputRef}
                className={`input${flashOk ? ' flash-ok' : ''}`}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasKey ? '已保存（输入新值可覆盖）' : '粘贴 API Key'}
                spellCheck={false}
              />
            </div>
            <div className="settings-hint">
              {hasKey
                ? 'Key 已存入系统安全区，永不写入工程 JSON。'
                : 'Key 仅存本地系统安全区（Tauri keyring），不上传任何服务器。'}
            </div>
            {hasKey && (
              <button
                className="btn btn-plain btn-danger"
                onClick={deleteKey}
                style={{ alignSelf: 'flex-start' }}
              >
                清除已保存的 Key
              </button>
            )}
          </div>

          {/* 测试连接 */}
          <div className="settings-section">
            <div className="settings-section-title">连接验证</div>
            <button
              className="btn btn-secondary"
              onClick={doTest}
              disabled={testing}
              style={{ alignSelf: 'flex-start' }}
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
            {testResult && (
              <div
                className="settings-error"
                style={{
                  color: testResult.ok
                    ? 'var(--success)'
                    : 'var(--danger)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {testResult.ok ? (
                  <>
                    <IconCheck size={12} /> 连接成功
                  </>
                ) : (
                  <>
                    <IconX size={12} /> {testResult.msg}
                  </>
                )}
              </div>
            )}
          </div>

          {/* 主题 */}
          <div className="settings-section">
            <div className="settings-section-title">外观</div>
            <div className="settings-row" style={{ gap: 8 }}>
              {(['system', 'light', 'dark'] as ThemeChoice[]).map((t) => (
                <button
                  key={t}
                  className={`btn ${theme === t ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setTheme(t)}
                  style={{ flex: 1 }}
                >
                  {t === 'light' && <IconSun size={12} />}
                  {t === 'dark' && <IconMoon size={12} />}
                  {t === 'system' ? '跟随系统' : t === 'light' ? '浅色' : '深色'}
                </button>
              ))}
            </div>
          </div>

          {/* 保存 */}
          <button
            className="btn btn-primary"
            onClick={save}
            style={{ marginTop: 4 }}
          >
            <IconSettings size={12} />
            保存设置
          </button>
        </div>
      </aside>
    </>
  )
}

/**
 * Agent 访问：让 Codex / Claude Code / Kimi Code 等命令行 agent 读写这篇文稿。
 * 默认只能提建议；"直接修改"必须由作者在这里明确授权，可随时收回。
 */
import { useState } from 'react'
import type { AgentAccess } from '../types'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useDocsStore } from '../store/docsStore'
import { isTauri } from '../lib/platform'
import { useBridgeStore } from '../store/bridgeStore'
import { IconX } from './icons'

export function AgentAccessModal() {
  const access: AgentAccess = useProjectStore((s) => s.data?.meta.agentAccess ?? 'propose')
  const path = useDocsStore((s) => s.current?.path ?? null)
  const bridgeOnline = useBridgeStore((s) => s.online)
  const agents = useBridgeStore((s) => s.agents)
  const [confirming, setConfirming] = useState(false)
  const close = () => useUIStore.getState().setAgentOpen(false)
  const setAccess = (a: AgentAccess) => {
    useProjectStore.getState().setAgentAccess(a)
    setConfirming(false)
    useUIStore.getState().pushToast({
      kind: 'success',
      text: a === 'direct' ? '已允许 Agent 直接修改这篇文稿' : '已收回直接修改权限，Agent 只能提建议',
    })
  }
  const fileArg = bridgeOnline ? '@' : path ? `"${path}"` : '稿子.suixin.json'
  const example = `suixin replace ${fileArg} --quote "原文里的一句" --text "改后的一句" --as "Claude Code"`
  const mcpAdd = 'claude mcp add suixin -- suixin mcp'
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)
    useUIStore.getState().pushToast({ kind: 'info', text: '已复制' })
  }

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="modal agent-modal" role="dialog" aria-label="Agent 访问">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>
            Agent 访问
          </div>
          <button className="icon-btn" onClick={close} title="关闭（Esc）" aria-label="关闭">
            <IconX />
          </button>
        </div>
        <p className="modal-desc">
          让 Codex、Claude Code、Kimi Code 等命令行 agent 用 <code>suixin</code> 读写这篇文稿。
          它们提出的修改会署名显示，由你决定是否写入。
        </p>
        {bridgeOnline && (
          <div className="settings-hint agent-live" role="status">
            实时连接已开启：App 开着时，agent 的修改会立即出现，你的接受与放弃也会马上告诉它。
            {agents.length > 0 ? (
              <div className="agent-online-list" aria-label="在线的 Agent">
                {agents.map((a) => (
                  <span key={a.name} className="agent-badge">
                    {a.name}
                    {a.waiting ? ' · 等待中' : ''}
                  </span>
                ))}
              </div>
            ) : (
              <> 目前没有 agent 连着。</>
            )}
          </div>
        )}

        <div className="access-options" role="radiogroup" aria-label="权限">
          <button
            role="radio"
            aria-checked={access === 'propose'}
            className={`access-option${access === 'propose' ? ' selected' : ''}`}
            onClick={() => access !== 'propose' && setAccess('propose')}
          >
            <span className="access-name">只能提建议（默认）</span>
            <span className="access-desc">agent 的修改成为待确认建议，你可以逐条或整组接受、放弃。</span>
          </button>
          <button
            role="radio"
            aria-checked={access === 'direct'}
            className={`access-option${access === 'direct' ? ' selected' : ''}`}
            onClick={() => access !== 'direct' && setConfirming(true)}
          >
            <span className="access-name">允许直接修改</span>
            <span className="access-desc">
              agent 显式加 <code>--direct</code> 时可直接改正文与结构（改标题、移动章节等）。每处改动都署名、
              记入版本历史，可以撤销。
            </span>
          </button>
        </div>
        {confirming && (
          <div className="access-confirm" role="alert">
            确定允许 agent 直接修改《{useProjectStore.getState().data?.meta.title}》吗？
            <span style={{ flex: 1 }} />
            <button className="btn btn-secondary" onClick={() => setConfirming(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => setAccess('direct')}>
              确认授权
            </button>
          </div>
        )}

        <div className="settings-section-title" style={{ marginTop: 20 }}>
          怎么连接
        </div>
        <ol className="agent-steps">
          <li>
            {bridgeOnline ? (
              <>
                App 开着时，agent 用 <code>@</code> 代表你正在看的这篇文稿（如 <code>suixin outline @</code>）
                {path && (
                  <>
                    ；也可以用文件路径：<code className="agent-path">{path}</code>
                  </>
                )}
                。
              </>
            ) : path ? (
              <>
                这篇文稿的文件：<code className="agent-path">{path}</code>
              </>
            ) : isTauri ? (
              <>先按 Ctrl+Shift+S 把文稿另存为文件，agent 才能访问它。</>
            ) : (
              <>浏览器模式下 agent 访问不到文稿库：用「文件 → 下载工程文件」得到 .suixin.json，改完再打开。</>
            )}
          </li>
          <li>
            让 agent 先运行 <code>suixin guide</code>，它会知道怎么做。
            <button className="link-btn" onClick={() => copy('suixin guide')}>
              复制
            </button>
          </li>
          <li>
            作为 MCP 服务接入（推荐）：<code className="agent-example">{mcpAdd}</code>
            <button className="link-btn" onClick={() => copy(mcpAdd)}>
              复制
            </button>
            <span className="settings-hint" style={{ display: 'block' }}>
              Codex 用 <code>codex mcp add suixin -- suixin mcp</code>；其他 harness 配置命令 <code>suixin mcp</code> 即可。
            </span>
          </li>
          <li>
            或直接用命令行，示例：<code className="agent-example">{example}</code>
            <button className="link-btn" onClick={() => copy(example)}>
              复制
            </button>
          </li>
        </ol>
        <p className="settings-hint">
          {bridgeOnline
            ? 'agent 需要直接修改时，会在这里弹窗请你授权。App 没开时，agent 改的是文件，下次打开会自动载入。'
            : 'agent 改了文件后，这里会自动载入；如果你这边也有没保存的改动，会先询问你保留哪一份。'}
        </p>
      </div>
    </div>
  )
}

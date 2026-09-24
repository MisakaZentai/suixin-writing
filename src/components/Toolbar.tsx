/** 顶栏：品牌（返回文稿列表）· 标题 · 保存状态 · 文件菜单 · 待办 · 帮助 · 设置 */
import { useEffect, useRef, useState } from 'react'
import { IconHelp, IconList, IconSettings, IconSidebar, IconSparkles } from './icons'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useDocsStore } from '../store/docsStore'
import { isTauri } from '../lib/platform'
import { isActive } from '../lib/tasks'
import { useBridgeStore } from '../store/bridgeStore'
import { exportHtml } from '../store/exportActions'
import { MenuItem } from './BlockCard'
import { inferSections, reviewWholeDocument } from '../store/aiActions'

interface Props {
  scrolled: boolean
}

export function Toolbar({ scrolled }: Props) {
  const hasDoc = useProjectStore((s) => s.data != null)
  const title = useProjectStore((s) => s.data?.meta.title ?? '')
  const canInfer = useProjectStore(
    (s) =>
      s.data != null &&
      !s.data.blocks.some((b) => b.type === 'heading') &&
      s.data.blocks.some((b) => b.type === 'paragraph' && b.text.trim())
  )
  const pendingCount = useProjectStore(
    (s) =>
      (s.data?.suggestions.filter((x) => x.state === 'pending').length ?? 0) +
      (s.data?.tasks?.filter(isActive).length ?? 0)
  )
  // agent 做完的任务不计数，但要留个入口让作者看到结果
  const doneTasks = useProjectStore((s) => s.data?.tasks?.some((t) => t.state === 'done') ?? false)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const suggestionsOpen = useUIStore((s) => s.suggestionsOpen)
  const ui = () => useUIStore.getState()
  const docs = () => useDocsStore.getState()

  return (
    // data-tauri-drag-region：Windows 桌面版的顶栏兼作标题栏，拖空白处移动窗口、双击最大化（只认直接点在带这个属性的元素上）
    <header className={`toolbar${scrolled ? ' scrolled' : ''}`} data-tauri-drag-region>
      {hasDoc && (
        <button
          className={`icon-btn${sidebarOpen ? ' active' : ''}`}
          onClick={() => ui().setSidebarOpen(!sidebarOpen)}
          title="大纲栏（收起即专注模式）"
          aria-label="切换大纲栏"
        >
          <IconSidebar />
        </button>
      )}
      <button
        className="toolbar-title"
        onClick={() => hasDoc && void docs().closeCurrent()}
        title={hasDoc ? '返回文稿列表' : undefined}
        disabled={!hasDoc}
      >
        随心写作
      </button>
      {hasDoc && (
        <>
          <input
            className="toolbar-doc-title"
            value={title}
            onChange={(e) => useProjectStore.getState().renameTitle(e.target.value)}
            aria-label="文稿标题"
            spellCheck={false}
          />
          <SaveStatus />
          <div className="toolbar-spacer" data-tauri-drag-region />
          <AgentPresence />
          <AIMenu canInfer={canInfer} />
          <FileMenu />
          {(pendingCount > 0 || doneTasks) && (
            <div className="badge-wrap">
              <button
                className={`icon-btn${suggestionsOpen ? ' active' : ''}`}
                onClick={() => ui().setSuggestionsOpen(!suggestionsOpen)}
                title="待办：未确认的修改、检查建议与交给 Agent 的任务"
                aria-label={pendingCount > 0 ? `待办 ${pendingCount} 项` : '待办：任务已完成'}
              >
                <IconList />
              </button>
              {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
            </div>
          )}
        </>
      )}
      {!hasDoc && <div className="toolbar-spacer" data-tauri-drag-region />}
      <button className="icon-btn" onClick={() => ui().setHelpOpen(true)} title="快捷键与帮助（?）" aria-label="帮助">
        <IconHelp />
      </button>
      <button className="icon-btn" onClick={() => ui().setSettingsOpen(true)} title="设置" aria-label="设置">
        <IconSettings />
      </button>
    </header>
  )
}

/** 实时连着的 agent：点开看详情与权限 */
function AgentPresence() {
  const agents = useBridgeStore((s) => s.agents)
  if (!agents.length) return null
  const names = agents.map((a) => a.name)
  const label = names.length === 1 ? names[0] : `${names[0]} 等 ${names.length} 个`
  return (
    <button
      className="agent-presence"
      onClick={() => useUIStore.getState().setAgentOpen(true)}
      title={`在线：${names.join('、')}`}
      aria-label={`在线的 Agent：${names.join('、')}`}
    >
      <span className="agent-presence-dot" aria-hidden="true" />
      {label}
    </button>
  )
}

function SaveStatus() {
  const status = useDocsStore((s) => s.status)
  const error = useDocsStore((s) => s.error)
  const path = useDocsStore((s) => s.current?.path ?? null)
  if (status === 'error') {
    return (
      <button
        className="save-status error"
        title={error ?? undefined}
        onClick={() => void useDocsStore.getState().flush()}
      >
        保存失败 · 重试
      </button>
    )
  }
  const busy = status === 'pending' || status === 'saving'
  return (
    <span
      className={`save-status${busy ? ' busy' : ''}`}
      role="status"
      data-tauri-drag-region
      title={path ? `已同步到 ${path}` : '自动保存在本机文稿库；Ctrl+Shift+S 可另存为文件'}
    >
      {busy ? '保存中…' : '已保存'}
    </span>
  )
}

/** 通用下拉菜单外壳：点击外部关闭 */
function useDropdown() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return { open, setOpen, ref, run }
}

/** 全文级 AI：检查全文、划分章节、写作设定 */
function AIMenu({ canInfer }: { canInfer: boolean }) {
  const { open, setOpen, ref, run } = useDropdown()
  return (
    <div className="toolbar-group" ref={ref} style={{ position: 'relative' }}>
      <button className="btn btn-plain" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <IconSparkles />
        AI
      </button>
      {open && (
        <div className="popover file-menu" role="menu">
          <MenuItem label="检查全文" onClick={run(() => void reviewWholeDocument())} />
          <MenuItem label="检查 AI 味" onClick={run(() => useUIStore.getState().setFlavorOpen(true))} />
          <MenuItem
            label={canInfer ? '划分章节' : '划分章节（已有标题）'}
            onClick={run(() => {
              if (canInfer) void inferSections()
              else useUIStore.getState().pushToast({ kind: 'info', text: '文中已经有标题了，可在大纲里调整' })
            })}
          />
          <div className="context-menu-sep" />
          <MenuItem label="写作设定…" onClick={run(() => useUIStore.getState().setBriefOpen(true))} />
          <MenuItem label="Agent 访问…" onClick={run(() => useUIStore.getState().setAgentOpen(true))} />
          <MenuItem label="AI 服务设置…" onClick={run(() => useUIStore.getState().setSettingsOpen(true))} />
        </div>
      )}
    </div>
  )
}

function FileMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const docs = () => useDocsStore.getState()

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <div className="toolbar-group" ref={ref} style={{ position: 'relative' }}>
      <button className="btn btn-plain" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        文件
      </button>
      {open && (
        <div className="popover file-menu" role="menu">
          <MenuItem
            label="新建空白文稿"
            kbd="Ctrl+N"
            onClick={run(async () => {
              const first = await docs().newBlank()
              if (first) useUIStore.getState().beginEdit(first)
            })}
          />
          <MenuItem label="打开…" kbd="Ctrl+O" onClick={run(() => void docs().pickAndOpen())} />
          <MenuItem label="粘贴导入…" onClick={run(() => useUIStore.getState().setImportOpen(true))} />
          <MenuItem label="写作设定…" onClick={run(() => useUIStore.getState().setBriefOpen(true))} />
          <div className="context-menu-sep" />
          <MenuItem label={isTauri ? '保存' : '保存到文稿库'} kbd="Ctrl+S" onClick={run(() => void docs().save())} />
          <MenuItem
            label={isTauri ? '另存为…' : '下载工程文件'}
            kbd="Ctrl+Shift+S"
            onClick={run(() => void docs().saveAs())}
          />
          <MenuItem label="导出 Markdown…" kbd="Ctrl+Shift+E" onClick={run(() => void docs().exportMarkdown())} />
          <MenuItem label="导出 HTML（图片内嵌）…" onClick={run(() => void exportHtml())} />
          <MenuItem label="发布到知乎…" onClick={run(() => useUIStore.getState().setPublishOpen(true))} />
          <div className="context-menu-sep" />
          <MenuItem label="返回文稿列表" onClick={run(() => void docs().closeCurrent())} />
        </div>
      )}
    </div>
  )
}

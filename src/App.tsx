/**
 * App 组装：布局、主题、启动恢复、30s 自动保存、快捷键总路由。
 */
import { useCallback, useEffect, useState } from 'react'
import { Toolbar } from './components/Toolbar'
import { OutlineTree } from './components/OutlineTree'
import { BlockFlow } from './components/BlockFlow'
import { StartPage } from './components/StartPage'
import { ImportModal } from './components/ImportModal'
import { SettingsPanel } from './components/SettingsPanel'
import { SuggestionsPanel } from './components/SuggestionsPanel'
import { HelpOverlay } from './components/HelpOverlay'
import { BriefModal } from './components/BriefModal'
import { OutlineProposalModal } from './components/OutlineProposalModal'
import { AgentAccessModal } from './components/AgentAccessModal'
import { ExternalChangeBanner } from './components/ExternalChangeBanner'
import { Toasts } from './components/Toasts'
import { useShortcuts } from './hooks/useShortcuts'
import { useProjectStore } from './store/projectStore'
import { applyTheme, useUIStore } from './store/uiStore'
import { useAIConfigStore } from './store/aiConfigStore'
import { useDocsStore } from './store/docsStore'
import { customTitlebar, filesToImages, isTauri, readBinaryAt, readFileAt } from './lib/platform'
import { isImageName } from './lib/images'
import { insertImages } from './store/imageActions'
import { revealBlock } from './lib/scroll'
import { abortAI, regenerate } from './store/aiActions'
import { startBridge } from './bridge/connect'
import { AccessRequestDialog } from './components/AccessRequestDialog'
import { PublishModal } from './components/PublishModal'
import { WindowControls } from './components/WindowControls'
import { FlavorPanel } from './components/FlavorPanel'
import { useBaselineStore } from './store/baselineStore'

export function App() {
  const data = useProjectStore((s) => s.data)
  const importOpen = useUIStore((s) => s.importOpen)
  const settingsOpen = useUIStore((s) => s.settingsOpen)
  const suggestionsOpen = useUIStore((s) => s.suggestionsOpen)
  const flavorOpen = useUIStore((s) => s.flavorOpen)
  const helpOpen = useUIStore((s) => s.helpOpen)
  const briefOpen = useUIStore((s) => s.briefOpen)
  const outlineProposal = useUIStore((s) => s.outlineProposal)
  const agentOpen = useUIStore((s) => s.agentOpen)
  const publishOpen = useUIStore((s) => s.publishOpen)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth)
  const theme = useUIStore((s) => s.theme)
  const [scrolled, setScrolled] = useState(false)
  const [resizing, setResizing] = useState(false)

  /* ── 主题 ─────────────────────────────────────────── */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    applyTheme(theme, false)
    const onChange = () => applyTheme(theme, true)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  /* ── 启动：Key 状态 + 文稿库 + AI 味基线 + 与本机 agent 的实时桥 ─── */
  useEffect(() => {
    void useAIConfigStore.getState().refreshKeyPresence()
    void useDocsStore.getState().init()
    void useBaselineStore.getState().load()
    void startBridge()
  }, [])

  /* ── 离开前落盘（自动保存有 0.8s 延迟） ─────────────── */
  useEffect(() => {
    const flush = () => {
      useUIStore.getState().confirmEdit()
      void useDocsStore.getState().flush()
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [])

  /* ── 整个窗口接受文件拖放：打开为新文稿，绝不让浏览器跳转走 ── */
  const [dropping, setDropping] = useState(false)
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDropping(true)
    }
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDropping(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDropping(false)
      // 文稿开着时拖进来的图片：插进文稿
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (useProjectStore.getState().data && files.some((f) => f.type.startsWith('image/'))) {
        void filesToImages(files).then((imgs) => insertImages(imgs))
        return
      }
      const file = e.dataTransfer?.files[0]
      if (file) {
        void file.text().then((text) => useDocsStore.getState().openPicked({ name: file.name, text, path: null }))
      }
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)

    // 桌面版：拖放由 Tauri 接管，事件里带的是文件路径
    let unlisten: (() => void) | undefined
    if (isTauri) {
      void import('@tauri-apps/api/webview')
        .then(({ getCurrentWebview }) =>
          getCurrentWebview().onDragDropEvent(async (event) => {
            const p = event.payload
            if (p.type === 'over' || p.type === 'enter') setDropping(true)
            else if (p.type === 'leave') setDropping(false)
            else if (p.type === 'drop') {
              setDropping(false)
              const images = p.paths.filter(isImageName)
              if (useProjectStore.getState().data && images.length) {
                const picked = await Promise.all(
                  images.map(async (path) => ({ name: path.split(/[\\/]/).pop() ?? path, bytes: (await readBinaryAt(path)) ?? new Uint8Array() }))
                )
                await insertImages(picked)
                return
              }
              const path = p.paths[0]
              const text = path ? await readFileAt(path) : null
              if (path && text != null) {
                await useDocsStore.getState().openPicked({
                  name: path.split(/[\\/]/).pop() ?? path,
                  text,
                  path,
                })
              }
            }
          })
        )
        .then((fn) => {
          unlisten = fn
        })
        .catch(() => {
          /* 拿不到拖放事件时退回 HTML5 拖放 */
        })
    }
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      unlisten?.()
    }
  }, [])

  /* ── 侧栏拖拽调宽 ─────────────────────────────────── */
  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => setSidebarWidth(Math.min(360, Math.max(180, e.clientX)))
    const onUp = () => setResizing(false)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [resizing, setSidebarWidth])

  /* ── 快捷键总路由 ─────────────────────────────────── */
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const ui = useUIStore.getState()
      const ps = useProjectStore.getState()

      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const docs = useDocsStore.getState()
        const k = e.key.toLowerCase()
        const plain = !e.shiftKey
        if (plain && k === 'n') {
          e.preventDefault()
          void docs.newBlank().then((first) => first && useUIStore.getState().beginEdit(first))
        } else if (plain && k === 'o') {
          e.preventDefault()
          void docs.pickAndOpen()
        } else if (plain && k === 's') {
          e.preventDefault()
          ui.confirmEdit()
          void docs.save()
        } else if (!plain && k === 's') {
          e.preventDefault()
          ui.confirmEdit()
          void docs.saveAs()
        } else if (!plain && k === 'e') {
          e.preventDefault()
          ui.confirmEdit()
          void docs.exportMarkdown()
        } else if (plain && k === 'z') {
          e.preventDefault()
          ps.undo()
        } else if ((!plain && k === 'z') || (plain && k === 'y')) {
          e.preventDefault()
          ps.redo()
        }
        return
      }

      /* Esc：逐层退出——对照 > 生成 > 菜单 > 面板 > 指令框 > 编辑 > 选区 > 选中 */
      if (e.key === 'Escape') {
        if (ui.diff) ui.closeDiff()
        else if (ui.stream) abortAI()
        else if (ui.contextMenu) ui.setContextMenu(null)
        else if (ui.versionPanelId) ui.setVersionPanelId(null)
        else if (ui.settingsOpen) ui.setSettingsOpen(false)
        else if (ui.briefOpen) ui.setBriefOpen(false)
        else if (ui.outlineProposal) ui.setOutlineProposal(null)
        else if (ui.agentOpen) ui.setAgentOpen(false)
        else if (ui.publishOpen) ui.setPublishOpen(false)
        else if (ui.suggestionsOpen) ui.setSuggestionsOpen(false)
        else if (ui.flavorOpen) ui.setFlavorOpen(false)
        else if (ui.helpOpen) ui.setHelpOpen(false)
        else if (ui.importOpen) ui.setImportOpen(false)
        else if (ui.aiPrompt) ui.closeAIPrompt()
        else if (ui.editing) ui.confirmEdit()
        else if (ui.aiError) ui.setAIError(null)
        else if (ui.textRange) {
          window.getSelection()?.removeAllRanges()
          ui.setTextRange(null)
        } else if (ui.selection && ui.activeId) ui.setActive(ui.activeId)
        else if (ui.activeId) ui.setActive(null)
        return
      }

      /* 对照确认快捷键 */
      if (ui.diff && !ui.editing && !ui.aiPrompt) {
        const d = ui.diff
        const n = d.decisions.length || 1
        if (e.key === 'Enter') {
          e.preventDefault()
          ui.acceptDiff()
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault()
          ui.rejectDiff()
        } else if (e.code === 'KeyE') {
          e.preventDefault()
          ui.acceptAndEdit()
        } else if (e.code === 'KeyR') {
          e.preventDefault()
          const sg = useProjectStore.getState().data?.suggestions.find((x) => x.id === d.suggestionId)
          if (!sg?.author) void regenerate(d.suggestionId)
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          ui.switchCandidate(e.key === 'ArrowLeft' ? -1 : 1)
        } else if (e.code === 'KeyV') {
          const order = (d.whole ? ['result', 'compare'] : ['marked', 'result', 'compare']) as ('marked' | 'result' | 'compare')[]
          const views = d.insert ? order.filter((v) => v !== 'compare') : order
          ui.setDiffView(views[(views.indexOf(d.view) + 1) % views.length])
        } else if (!d.whole && d.view === 'marked') {
          if (e.key === 'Tab') {
            e.preventDefault()
            ui.focusCluster((d.focused + (e.shiftKey ? n - 1 : 1)) % n)
          } else if (e.code === 'KeyY') ui.setDecision(d.focused, true)
          else if (e.code === 'KeyN') ui.setDecision(d.focused, false)
        }
        return
      }

      /* 浮层 / 输入中不做块级快捷键 */
      if (
        ui.settingsOpen ||
        ui.helpOpen ||
        ui.briefOpen ||
        ui.outlineProposal ||
        ui.agentOpen ||
        ui.publishOpen ||
        ui.importOpen ||
        ui.contextMenu ||
        ui.editing ||
        ui.aiPrompt ||
        ui.stream
      ) {
        return
      }

      if (e.key === '?') {
        ui.setHelpOpen(true)
        return
      }
      if (!data) return

      /* 空格 / 斜杠：对当前选区（段内文字 / 多段 / 一段 / 一节）唤起 AI */
      if (e.code === 'Space' || e.code === 'Slash') {
        if (ui.activeId || ui.textRange) {
          e.preventDefault()
          ui.echoKey('ai')
          ui.openAIPrompt()
        }
        return
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const dir = e.key === 'ArrowDown' ? 1 : -1
        if (e.shiftKey) {
          ui.extendSelection(dir)
          return
        }
        const blocks = data.blocks
        if (!blocks.length) return
        const idx = blocks.findIndex((b) => b.id === ui.activeId)
        const next =
          dir > 0 ? Math.min(blocks.length - 1, idx + 1) : Math.max(0, (idx < 0 ? blocks.length : idx) - 1)
        const id = blocks[next].id
        ui.setActive(id)
        const el = document.querySelector<HTMLElement>(`[data-block-id="${id}"]`)
        const container = el?.closest<HTMLElement>('.column-wrap')
        if (el && container) revealBlock(container, el)
        return
      }

      const active = ui.activeId ? data.blocks.find((b) => b.id === ui.activeId) : undefined
      if (!active || ui.selection) return
      // 按物理键位识别，不受输入法与大小写影响
      if (e.code === 'KeyE' || e.key === 'Enter') {
        e.preventDefault()
        ui.echoKey('e')
        ui.beginEdit(active.id)
      }
    },
    [data]
  )

  /* 粘贴图片：插在当前段落后面；没打开文稿时 Ctrl+V 直接导入为新文稿 */
  const onPaste = useCallback((e: ClipboardEvent) => {
    const target = e.target as HTMLElement | null
    const images = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
    const inOtherField =
      target && (target.tagName === 'INPUT' || (target.tagName === 'TEXTAREA' && !target.classList.contains('block-edit')))
    if (images.length && useProjectStore.getState().data && !inOtherField) {
      e.preventDefault()
      void filesToImages(images).then((imgs) => insertImages(imgs))
      return
    }
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return
    }
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (!text.trim() || useProjectStore.getState().data) return
    e.preventDefault()
    const docs = useDocsStore.getState()
    const run = text.trim().startsWith('{') ? docs.openProjectText(text) : docs.importText(text)
    void run.catch((err: Error) =>
      useUIStore.getState().pushToast({ kind: 'error', text: `导入失败：${err.message}`, duration: 8000 })
    )
  }, [])

  useShortcuts({ onKey, onPaste })

  return (
    <div className={`app${suggestionsOpen || (flavorOpen && data) ? ' with-side-panel' : ''}`}>
      <Toolbar scrolled={scrolled} />
      {customTitlebar && <WindowControls />}
      <ExternalChangeBanner />
      <div className="body">
        {data && sidebarOpen && (
          <aside className="sidebar" style={{ width: sidebarWidth }}>
            <OutlineTree />
            <div
              className={`sidebar-resizer${resizing ? ' dragging' : ''}`}
              onMouseDown={() => setResizing(true)}
            />
          </aside>
        )}
        {data ? (
          <BlockFlow onScrolledChange={setScrolled} />
        ) : (
          <div className="column-wrap">
            <StartPage />
          </div>
        )}
      </div>
      {dropping && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card">{data ? '松开：图片插进文稿，其他文件打开为新文稿' : '松开即可打开为新文稿'}</div>
        </div>
      )}
      {importOpen && <ImportModal />}
      {settingsOpen && <SettingsPanel />}
      {suggestionsOpen && <SuggestionsPanel />}
      {flavorOpen && data && <FlavorPanel />}
      {helpOpen && <HelpOverlay />}
      {briefOpen && data && <BriefModal />}
      {outlineProposal && data && <OutlineProposalModal proposal={outlineProposal} />}
      {agentOpen && data && <AgentAccessModal />}
      {publishOpen && data && <PublishModal />}
      <AccessRequestDialog />
      <Toasts />
    </div>
  )
}

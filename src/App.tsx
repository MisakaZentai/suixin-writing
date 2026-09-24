/**
 * App 组装（spec §6 布局 + §6.3 快捷键总路由）。
 * - 主题应用 / API Key 状态刷新 / 启动恢复提示
 * - 30s 自动保存（崩溃保护）+ beforeunload
 * - 快捷键路由：粒度 1/2/3、块导航 ↑/↓、E/R/T、diff Tab/Y/N/Enter/Esc、
 *   Ctrl+S/Shift+S 导出、Ctrl+Z/Shift+Z 撤销重做
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Toolbar } from './components/Toolbar'
import { OutlineTree } from './components/OutlineTree'
import { BlockFlow } from './components/BlockFlow'
import { EmptyState } from './components/EmptyState'
import { ImportModal } from './components/ImportModal'
import { SettingsPanel } from './components/SettingsPanel'
import { SuggestionsPanel } from './components/SuggestionsPanel'
import { HelpOverlay } from './components/HelpOverlay'
import { Toasts } from './components/Toasts'
import { useShortcuts } from './hooks/useShortcuts'
import { useProjectStore } from './store/projectStore'
import { useUIStore } from './store/uiStore'
import { loadRecovery, saveRecovery, saveTextFile } from './lib/platform'
import {
  buildProjectJson,
  exportMarkdown,
  getDisplayBlocks,
} from './lib/project'
import { revealBlock } from './lib/scroll'

export function App() {
  const data = useProjectStore((s) => s.data)
  const activeKey = useUIStore((s) => s.activeKey)
  const importOpen = useUIStore((s) => s.importOpen)
  const settingsOpen = useUIStore((s) => s.settingsOpen)
  const suggestionsOpen = useUIStore((s) => s.suggestionsOpen)
  const helpOpen = useUIStore((s) => s.helpOpen)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth)
  const theme = useUIStore((s) => s.theme)
  const [scrolled, setScrolled] = useState(false)
  const [resizing, setResizing] = useState(false)

  /* ── 主题 ─────────────────────────────────────────── */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark =
        theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.setAttribute(
        'data-theme',
        dark ? 'dark' : 'light'
      )
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  /* ── 启动：Key 状态 + 恢复提示 ─────────────────────── */
  useEffect(() => {
    void useUIStore.getState().refreshApiKeyPresence()
    void loadRecovery().then((r) => {
      if (!r || !r.content.trim()) return
      if (useProjectStore.getState().data) return
      useUIStore.getState().pushToast({
        kind: 'info',
        text: '发现上次自动保存的文稿',
        actionLabel: '恢复',
        duration: 15000,
        onAction: () => {
          try {
            useProjectStore.getState().loadJson(r.content)
            useUIStore
              .getState()
              .pushToast({ kind: 'success', text: '已恢复自动保存的文稿' })
          } catch (e) {
            useUIStore.getState().pushToast({
              kind: 'error',
              text: `恢复失败：${(e as Error).message}`,
            })
          }
        },
      })
    })
  }, [])

  /* ── 30s 自动保存（spec F6 崩溃保护） ──────────────── */
  useEffect(() => {
    const id = window.setInterval(() => {
      const st = useProjectStore.getState()
      if (!st.unsaved || !st.data) return
      void saveRecovery(buildProjectJson(st.data))
      st.markSaved()
    }, 30_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const handler = () => {
      const st = useProjectStore.getState()
      if (st.unsaved && st.data) {
        void saveRecovery(buildProjectJson(st.data))
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  /* ── 导入 / 导出 ──────────────────────────────────── */
  const doImportText = useCallback((text: string) => {
    try {
      const { truncated } = useProjectStore.getState().importText(text)
      useUIStore.getState().setImportOpen(false)
      useUIStore.getState().pushToast({
        kind: truncated ? 'info' : 'success',
        text: truncated
          ? '文档超过 20 万字，已截断导入（原文仍在文件中）'
          : '导入完成，已自动拆块',
      })
    } catch (e) {
      useUIStore.getState().pushToast({
        kind: 'error',
        text: `导入失败：${(e as Error).message}`,
      })
    }
  }, [])

  const doImportJson = useCallback((text: string) => {
    try {
      useProjectStore.getState().loadJson(text)
      useUIStore.getState().setImportOpen(false)
      useUIStore.getState().pushToast({
        kind: 'success',
        text: '工程已读取，现场已恢复',
      })
    } catch (e) {
      useUIStore.getState().pushToast({
        kind: 'error',
        text: `读档失败：${(e as Error).message}`,
      })
    }
  }, [])

  const exportJsonFile = useCallback(async () => {
    const st = useProjectStore.getState()
    if (!st.data) return
    const name = `${st.data.meta.title || '未命名文稿'}.aiwriter.json`
    const saved = await saveTextFile(name, buildProjectJson(st.data))
    if (saved) {
      useUIStore
        .getState()
        .pushToast({ kind: 'success', text: `已导出工程 ${name}` })
    }
  }, [])

  const exportMdFile = useCallback(async () => {
    const st = useProjectStore.getState()
    if (!st.data) return
    const name = `${st.data.meta.title || '未命名文稿'}.md`
    const saved = await saveTextFile(name, exportMarkdown(st.data))
    if (saved) {
      useUIStore
        .getState()
        .pushToast({ kind: 'success', text: `已导出 ${name}` })
    }
  }, [])

  /* ── 侧栏拖拽调宽 ─────────────────────────────────── */
  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const w = Math.min(360, Math.max(180, e.clientX))
      setSidebarWidth(w)
    }
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

  /* ── 当前块 → 大纲节点（双向定位 spec F5） ─────────── */
  const activeOutlineNodeId = useMemo(() => {
    if (!data || !activeKey) return null
    if (activeKey === 'full') return data.blocks[0]?.outlineNodeId ?? null
    const id = activeKey.slice(2)
    const block = data.blocks.find((b) => b.id === id || b.paragraphId === id)
    return block?.outlineNodeId ?? null
  }, [data, activeKey])

  /* ── 快捷键总路由 ─────────────────────────────────── */
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const ui = useUIStore.getState()
      const ps = useProjectStore.getState()

      /* Ctrl / Cmd 组合 */
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const k = e.key.toLowerCase()
        if (k === 's') {
          e.preventDefault()
          void exportJsonFile()
        } else if (k === 'z') {
          e.preventDefault()
          ps.undo()
        }
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 's') {
          e.preventDefault()
          void exportMdFile()
        } else if (k === 'z') {
          e.preventDefault()
          ps.redo()
        }
        return
      }

      /* Esc：diff 全拒 > 中断生成 > 逐层关面板 / 退出编辑 */
      if (e.key === 'Escape') {
        if (ui.diff) {
          ui.decideAll(false)
        } else if (ui.stream) {
          ui.abortAI()
        } else if (ui.settingsOpen) {
          ui.setSettingsOpen(false)
        } else if (ui.suggestionsOpen) {
          ui.setSuggestionsOpen(false)
        } else if (ui.helpOpen) {
          ui.setHelpOpen(false)
        } else if (ui.importOpen) {
          ui.setImportOpen(false)
        } else if (ui.editing) {
          ui.cancelEdit()
        } else if (ui.opinion) {
          ui.cancelOpinion()
        }
        return
      }

      /* diff 快捷键（编辑态让位） */
      if (ui.diff && !ui.editing && !ui.opinion) {
        if (e.key === 'Tab') {
          e.preventDefault()
          const n = ui.diff.decisions.length || 1
          ui.focusCluster(
            (ui.diff.focused + (e.shiftKey ? n - 1 : 1)) % n
          )
        } else if (e.key === 'y' || e.key === 'Y') {
          ui.setDecision(ui.diff.focused, true)
        } else if (e.key === 'n' || e.key === 'N') {
          ui.setDecision(ui.diff.focused, false)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          ui.decideAll(true)
        }
        return
      }

      /* 浮层打开时不做块级快捷键 */
      if (
        ui.settingsOpen ||
        ui.helpOpen ||
        ui.importOpen ||
        ui.editing ||
        ui.opinion ||
        ui.stream
      ) {
        return
      }

      if (!data) {
        if (e.key === '?') ui.setHelpOpen(true)
        return
      }

      /* 粒度 */
      if (e.key === '1') ui.setGranularity('sentence')
      else if (e.key === '2') ui.setGranularity('paragraph')
      else if (e.key === '3') ui.setGranularity('full')
      /* 块导航 */
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const blocks = getDisplayBlocks(data, ui.granularity)
        if (!blocks.length) return
        const idx = blocks.findIndex((b) => b.key === ui.activeKey)
        const next =
          e.key === 'ArrowDown'
            ? Math.min(blocks.length - 1, (idx < 0 ? -1 : idx) + 1)
            : Math.max(0, (idx < 0 ? blocks.length : idx) - 1)
        const key = blocks[next].key
        ui.setActive(key)
        const el = document.querySelector<HTMLElement>(
          `[data-block-key="${key.replace(/"/g, '\\"')}"]`
        )
        const container = el?.closest<HTMLElement>('.column-wrap')
        if (el && container) revealBlock(container, el)
      }
      /* 块级操作 E/R/T */
      else if ((e.key === 'e' || e.key === 'E') && ui.activeKey) {
        const block = getDisplayBlocks(data, ui.granularity).find(
          (b) => b.key === ui.activeKey
        )
        if (block) ui.beginEdit(block.key, block.text)
      } else if ((e.key === 'r' || e.key === 'R') && ui.activeKey) {
        ui.beginOpinion(ui.activeKey)
      } else if ((e.key === 't' || e.key === 'T') && ui.activeKey) {
        void ui.startRewrite(ui.activeKey)
      }
      /* 帮助 */
      else if (e.key === '?') {
        ui.setHelpOpen(true)
      }
    },
    [data, exportJsonFile, exportMdFile]
  )

  /* 空文档 / 空内容时 Ctrl+V 直接导入 */
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const ui = useUIStore.getState()
      if (ui.editing || ui.opinion) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text.trim()) return
      if (!useProjectStore.getState().data) {
        e.preventDefault()
        doImportText(text)
      }
    },
    [doImportText]
  )

  useShortcuts({ onKey, onPaste })

  return (
    <div className="app">
      <Toolbar scrolled={scrolled} />
      <div className="body">
        {data && sidebarOpen && (
          <aside className="sidebar" style={{ width: sidebarWidth }}>
            <OutlineTree activeOutlineNodeId={activeOutlineNodeId} />
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
            <EmptyState
              onImportText={doImportText}
              onImportJson={doImportJson}
            />
          </div>
        )}
      </div>
      {importOpen && (
        <ImportModal onImportText={doImportText} onImportJson={doImportJson} />
      )}
      {settingsOpen && <SettingsPanel />}
      {suggestionsOpen && <SuggestionsPanel />}
      {helpOpen && <HelpOverlay />}
      <Toasts />
    </div>
  )
}

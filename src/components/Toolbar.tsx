/** 顶栏：标题 | 粒度切换 | 导入 | 导出 | 待办 | 设置（spec §6.1） */
import { useEffect, useRef, useState } from 'react'
import { SegmentedControl, type SegmentedItem } from './SegmentedControl'
import {
  IconDownload,
  IconHelp,
  IconList,
  IconPlus,
  IconSettings,
  IconSidebar,
  IconSparkles,
  IconUpload,
} from './icons'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { saveTextFile, openTextFile } from '../lib/platform'
import { buildProjectJson, exportMarkdown } from '../lib/project'
import type { Granularity } from '../types'

const SEGMENTS: SegmentedItem<Granularity>[] = [
  { value: 'sentence', label: '句子', hint: '快捷键 1' },
  { value: 'paragraph', label: '段落', hint: '快捷键 2' },
  { value: 'full', label: '全文', hint: '快捷键 3' },
]

interface Props {
  scrolled: boolean
}

export function Toolbar({ scrolled }: Props) {
  const data = useProjectStore((s) => s.data)
  const granularity = useUIStore((s) => s.granularity)
  const setGranularity = useUIStore((s) => s.setGranularity)
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setHelpOpen = useUIStore((s) => s.setHelpOpen)
  const setImportOpen = useUIStore((s) => s.setImportOpen)
  const setSuggestionsOpen = useUIStore((s) => s.setSuggestionsOpen)
  const suggestionsOpen = useUIStore((s) => s.suggestionsOpen)
  const runInferOutline = useUIStore((s) => s.runInferOutline)
  const renameTitle = useProjectStore((s) => s.renameTitle)

  const [exportOpen, setExportOpen] = useState(false)
  const exportRef = useRef<HTMLDivElement>(null)

  const pendingCount =
    data?.suggestions.filter((s) => s.state === 'pending').length ?? 0

  useEffect(() => {
    if (!exportOpen) return
    const close = (e: MouseEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [exportOpen])

  const doExportMd = async () => {
    if (!data) return
    const md = exportMarkdown(data)
    const name = `${data.meta.title || '未命名文稿'}.md`
    const saved = await saveTextFile(name, md)
    if (saved) {
      useUIStore.getState().pushToast({ kind: 'success', text: `已导出 ${name}` })
    }
    setExportOpen(false)
  }

  const doExportJson = async () => {
    if (!data) return
    const json = buildProjectJson(data)
    const name = `${data.meta.title || '未命名文稿'}.aiwriter.json`
    const saved = await saveTextFile(name, json)
    if (saved) {
      useUIStore
        .getState()
        .pushToast({ kind: 'success', text: `已导出工程 ${name}` })
    }
    setExportOpen(false)
  }

  const doOpen = async () => {
    const file = await openTextFile()
    if (!file) return
    setExportOpen(false)
    try {
      if (file.name.toLowerCase().endsWith('.json')) {
        useProjectStore.getState().loadJson(file.text)
        useUIStore.getState().pushToast({ kind: 'success', text: '工程已读取' })
      } else {
        const { truncated } = useProjectStore.getState().importText(file.text)
        useUIStore.getState().pushToast({
          kind: truncated ? 'info' : 'success',
          text: truncated
            ? '文档超过 20 万字，已截断导入（原文仍在文件中）'
            : `已导入「${file.name}」`,
        })
      }
    } catch (e) {
      useUIStore.getState().pushToast({
        kind: 'error',
        text: `打开失败：${(e as Error).message}`,
      })
    }
  }

  return (
    <header className={`toolbar${scrolled ? ' scrolled' : ''}`}>
      <button
        className={`icon-btn${sidebarOpen ? ' active' : ''}`}
        onClick={() => setSidebarOpen(!sidebarOpen)}
        title="大纲栏（可收起进入专注模式）"
        aria-label="切换大纲栏"
      >
        <IconSidebar />
      </button>
      <span className="toolbar-title">AI Writer</span>
      {data && (
        <>
          <input
            className="toolbar-doc-title"
            value={data.meta.title}
            onChange={(e) => renameTitle(e.target.value)}
            aria-label="文档标题"
            spellCheck={false}
          />
          <div className="toolbar-spacer" />
          <SegmentedControl
            value={granularity}
            items={SEGMENTS}
            onChange={setGranularity}
            ariaLabel="粒度切换"
          />
          <div className="toolbar-divider" />
          <button
            className="btn btn-plain"
            onClick={() => setImportOpen(true)}
            title="粘贴 / 文件导入"
          >
            <IconUpload />
            导入
          </button>
          <div className="toolbar-group" ref={exportRef} style={{ position: 'relative' }}>
            <button
              className="btn btn-plain"
              onClick={() => setExportOpen((v) => !v)}
              title="导出（Ctrl+S 工程 JSON）"
            >
              <IconDownload />
              导出
            </button>
            {exportOpen && (
              <div
                className="popover"
                style={{ position: 'absolute', top: 34, right: 0, width: 200 }}
              >
                <button
                  className="context-menu-item"
                  onClick={doExportMd}
                  style={{ justifyContent: 'flex-start' }}
                >
                  导出 Markdown
                  <span className="kbd" style={{ marginLeft: 'auto' }}>
                    Ctrl+⇧+S
                  </span>
                </button>
                <button
                  className="context-menu-item"
                  onClick={doExportJson}
                  style={{ justifyContent: 'flex-start' }}
                >
                  导出工程 JSON
                  <span className="kbd" style={{ marginLeft: 'auto' }}>
                    Ctrl+S
                  </span>
                </button>
                <div className="context-menu-sep" />
                <button
                  className="context-menu-item"
                  onClick={doOpen}
                  style={{ justifyContent: 'flex-start' }}
                >
                  打开工程 / 文档…
                </button>
              </div>
            )}
          </div>
          {!data.outline.length && data.blocks.length > 0 && (
            <button
              className="btn btn-plain"
              onClick={() => void runInferOutline()}
              title="让 AI 阅读正文，反推出大纲结构"
            >
              <IconSparkles />
              反推大纲
            </button>
          )}
          <div className="badge-wrap">
            <button
              className={`icon-btn${suggestionsOpen ? ' active' : ''}`}
              onClick={() => setSuggestionsOpen(!suggestionsOpen)}
              title="待办：未确认的 AI 产出与对齐建议"
              aria-label="待办面板"
            >
              <IconList />
            </button>
            {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
          </div>
        </>
      )}
      <div className="toolbar-spacer" />
      <button
        className="icon-btn"
        onClick={() => setHelpOpen(true)}
        title="快捷键与帮助（?）"
        aria-label="帮助"
      >
        <IconHelp />
      </button>
      <button
        className="icon-btn"
        onClick={() => setSettingsOpen(true)}
        title="设置：API Key / 模型 / 主题"
        aria-label="设置"
      >
        <IconSettings />
      </button>
      {!data && (
        <button className="btn btn-primary" onClick={() => setImportOpen(true)}>
          <IconPlus />
          新建文稿
        </button>
      )}
    </header>
  )
}

/**
 * 段落卡片——应用的心脏。
 * 阅读 ↔ 编辑 ↔ 意见 ↔ 生成 ↔ diff 用同一容器连续形变表达，全部就地呈现。
 *
 * 性能纪律：store 订阅都是字段级 selector，任何状态变化只重渲染涉及的段落。
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ParagraphBlock } from '../types'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useHeightMorph } from '../hooks/useHeightMorph'
import { countChars, pendingIndex } from '../lib/doc'
import { caretOffsetFromPoint } from '../lib/caret'
import { DiffView } from './DiffView'
import { StreamView } from './StreamView'
import { VersionPopover } from './VersionPopover'
import { IconComment, IconEdit, IconHistory, IconSparkles } from './icons'
import { AIErrorStrip, AIPromptBox } from './AIPromptBox'
import { abortAI, deflavorBlock, runScope } from '../store/aiActions'
import type { DiffOp, Suggestion } from '../types'
import { isImeKey } from '../lib/ime'
import { extOf, imageLine, parseImage } from '../lib/images'
import { putAsset } from '../lib/assets'
import { pickImages } from '../lib/platform'
import { currentAssetCtx, insertImages } from '../store/imageActions'
import { ImageFigure } from './ImageFigure'
import { PendingInsertLink } from './PendingInsertLink'
import type { FlavorHit, Severity } from '../lib/flavor'
import { adviceOf } from '../lib/flavor/project'
import { useBlockFlavorHits } from '../store/flavorActions'
import { MdText, type Highlight } from './MdText'
import { MdBackdrop, FormatBar, formatShortcut } from './MdEditing'

interface Props {
  block: ParagraphBlock
  /** 所在章节路径，如"第一章 / 第一节" */
  pathText: string
  /** 所在章节的标题层级（转为标题时用它 +1） */
  parentLevel: number
  /** 上一块也是段落时才能"与上一段合并" */
  canMergeUp: boolean
  enterDelay?: number
}

export const BlockCard = memo(function BlockCard({
  block,
  pathText,
  parentLevel,
  canMergeUp,
  enterDelay = 0,
}: Props) {
  const id = block.id
  /* ── 字段级订阅 ───────────────────────────────────── */
  const active = useUIStore((s) => s.activeId === id)
  const editing = useUIStore((s) => (s.editing?.id === id ? s.editing : null))
  const prompt = useUIStore((s) =>
    s.aiPrompt && s.aiPrompt.scope.anchorId === id && s.aiPrompt.scope.kind !== 'section' ? s.aiPrompt : null
  )
  /** 正在对这一段的某段文字发起 AI（指令框 / 生成中）：高亮该片段 */
  const markedRange = useUIStore((s) =>
    s.aiPrompt?.scope.kind === 'range' && s.aiPrompt.scope.anchorId === id ? s.aiPrompt.scope.range ?? null : null
  )
  const inSelection = useUIStore((s) => s.selection?.ids.includes(id) ?? false)
  const selectionSize = useUIStore((s) => (s.activeId === id ? (s.selection?.ids.length ?? 1) : 1))
  const stream = useUIStore((s) => (s.stream && !s.stream.insert && s.stream.anchorId === id ? s.stream : null))
  const diff = useUIStore((s) => (s.diff && !s.diff.insert && s.diff.anchorId === id ? s.diff : null))
  /** 多段目标里除第一段以外的段落：生成 / 确认期间收起，内容由第一段统一展示 */
  const covered = useUIStore(
    (s) =>
      (s.stream != null && s.stream.anchorId !== id && s.stream.blockIds.includes(id)) ||
      (s.diff != null && s.diff.anchorId !== id && s.diff.blockIds.includes(id))
  )
  const versionPanelOpen = useUIStore((s) => s.versionPanelId === id)
  const keyEcho = useUIStore((s) => (s.activeId === id ? s.keyEcho : null))
  const menu = useUIStore((s) => (s.contextMenu?.id === id ? s.contextMenu : null))
  const diffSuggestion = useProjectStore((s) =>
    diff ? s.data?.suggestions.find((sg) => sg.id === diff.suggestionId) : undefined
  )
  const pendingDiffId = useProjectStore((s) =>
    s.data ? pendingIndex(s.data.suggestions).diffByAnchor.get(id) ?? null : null
  )
  const pendingAuthor = useProjectStore((s) =>
    pendingDiffId ? s.data?.suggestions.find((x) => x.id === pendingDiffId)?.author?.name ?? null : null
  )
  const flavorHits = useBlockFlavorHits(id)
  const noteCount = useProjectStore((s) =>
    s.data ? pendingIndex(s.data.suggestions).notesByAnchor.get(id) ?? 0 : 0
  )

  const showDiff = diff != null && diffSuggestion != null
  const mode = editing ? 'edit' : showDiff ? 'diff' : stream ? 'stream' : prompt ? 'prompt' : 'read'
  const { ref: morphRef, ghost } = useHeightMorph<HTMLDivElement>(mode)

  const rootRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const backdropRef = useRef<HTMLParagraphElement>(null)
  const markdown = useUIStore((s) => s.markdown)
  const captionRef = useRef<HTMLInputElement>(null)
  const [toolbarBelow, setToolbarBelow] = useState(false)
  /** 图片段落：一行 ![图注](路径)。编辑时只改图注 */
  const image = parseImage(editing?.draft ?? block.text)

  /* 进入编辑态立即聚焦并把光标放到指定位置：不能等形变动画结束，否则手快时
     开头几个字会丢；preventScroll 避免动画中途抢滚动 */
  useLayoutEffect(() => {
    const el = textareaRef.current ?? captionRef.current
    if (!editing || !el) return
    el.focus({ preventScroll: true })
    const caret = el === captionRef.current ? el.value.length : Math.min(editing.caret ?? el.value.length, el.value.length)
    el.setSelectionRange(caret, caret)
    // 只在进入编辑或需要重新定位光标（token 变化）时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.token])

  /* textarea 自适应高度 */
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [editing?.draft])

  /* 右键菜单：点击菜单外任意处关闭（Esc 由全局快捷键处理） */
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest('.context-menu')) return
      useUIStore.getState().setContextMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  /* 浮动操作条防裁剪：块顶离顶栏太近时翻到块下方 */
  useEffect(() => {
    if (!active || mode !== 'read') return
    let ticking = false
    const check = () => {
      ticking = false
      const el = rootRef.current
      if (el) setToolbarBelow(el.getBoundingClientRect().top < 96)
    }
    check()
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(check)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [active, mode])

  if (covered) return null

  const ui = () => useUIStore.getState()
  const classes = [
    'block',
    mode,
    active ? 'active' : '',
    pendingDiffId ? 'pending' : '',
    inSelection ? 'in-selection' : '',
    mode !== 'read' ? 'busy' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const renderMode = (m: string, isGhost: boolean) => {
    switch (m) {
      case 'edit':
        if (image) {
          return (
            <div className="figure-edit">
              <ImageFigure src={image.src} caption="" />
              <input
                ref={isGhost ? undefined : captionRef}
                className="caption-edit"
                value={image.caption}
                readOnly={isGhost}
                placeholder="图注（可以留空）"
                aria-label="编辑图注"
                onChange={(e) => ui().updateEditDraft(imageLine(e.target.value, image.src))}
                onBlur={(e) => {
                  if (isGhost || !document.hasFocus()) return
                  const next = e.relatedTarget as HTMLElement | null
                  if (next && rootRef.current?.contains(next)) return
                  if (ui().editing?.id === id) ui().confirmEdit()
                }}
                onKeyDown={(e) => handleCaptionKey(e, id)}
              />
            </div>
          )
        }
        return (
          <div className="md-edit">
            {/* Markdown 模式：语法就地生效的垫层；关掉时只用来量格式浮条的位置 */}
            <MdBackdrop ref={isGhost ? undefined : backdropRef} text={editing?.draft ?? block.text} visible={markdown} />
            <textarea
              ref={isGhost ? undefined : textareaRef}
              className={`block-edit${markdown ? ' md-on' : ''}`}
              rows={1}
              value={editing?.draft ?? block.text}
              readOnly={isGhost}
              aria-label="编辑段落"
              onChange={(e) => ui().updateEditDraft(e.target.value)}
              onBlur={(e) => {
                // 焦点移到别处（点击空白、切换窗口）即完成编辑；移进本卡片的浮层不算
                // 切到别的窗口查资料时保持编辑态
                if (isGhost || !document.hasFocus()) return
                const next = e.relatedTarget as HTMLElement | null
                if (next && rootRef.current?.contains(next)) return
                if (ui().editing?.id === id) ui().confirmEdit()
              }}
              onKeyDown={(e) => handleEditorKey(e, id)}
            />
            {!isGhost && <FormatBar textareaRef={textareaRef} backdropRef={backdropRef} />}
          </div>
        )
      case 'prompt':
        return (
          <div>
            {image ? (
              <ImageFigure src={image.src} caption={image.caption} />
            ) : (
              <ParagraphText text={block.text} range={markedRange} hits={flavorHits} />
            )}
            {!isGhost && prompt && <AIPromptBox scope={prompt.scope} />}
          </div>
        )
      case 'stream':
        return stream ? <StreamView tw={stream.tw} onAbort={abortAI} /> : null
      case 'diff':
        return diff && diffSuggestion ? (
          <DiffView ops={opsInContext(diffSuggestion, block.text)} suggestion={diffSuggestion} diff={diff} />
        ) : null
      default:
        return (
          <div>
            {image ? (
              <ImageFigure src={image.src} caption={image.caption} showEmptyCaption={active} />
            ) : (
              <ParagraphText text={block.text} range={markedRange} hits={flavorHits} />
            )}
            {!isGhost && (pendingDiffId || noteCount > 0) && (
              <span className="pending-inline">
                {pendingDiffId && (
                  <button className="pending-link" onClick={() => ui().openDiff(pendingDiffId)}>
                    <IconSparkles size={12} />
                    {pendingAuthor ? `${pendingAuthor} 的修改待确认` : 'AI 修改待确认'}，点击查看
                  </button>
                )}
                {noteCount > 0 && (
                  <button className="pending-link note" onClick={() => ui().setSuggestionsOpen(true)}>
                    <IconComment size={12} />
                    {noteCount} 条检查建议
                  </button>
                )}
              </span>
            )}
            {!isGhost && <PendingInsertLink afterId={id} />}
          </div>
        )
    }
  }

  const closeMenu = () => ui().setContextMenu(null)

  return (
    <div
      ref={rootRef}
      className={classes}
      data-block-id={id}
      style={enterDelay ? { animationDelay: `${enterDelay}ms` } : undefined}
      onClick={(e) => {
        // 用户正在拖选文本时不切换选中，避免干扰复制
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed && sel.toString().length > 0) return
        if (mode !== 'read') return
        const { activeId } = ui()
        if (e.shiftKey && activeId && activeId !== id) {
          window.getSelection()?.removeAllRanges()
          ui().selectRange(ui().selection?.anchorId ?? activeId, id)
          return
        }
        if (activeId !== id || ui().selection) ui().setActive(id)
      }}
      onDoubleClick={(e) => {
        if (mode !== 'read') return
        const textEl = rootRef.current?.querySelector<HTMLElement>('.block-text')
        const caret = textEl ? caretOffsetFromPoint(textEl, e.clientX, e.clientY) : undefined
        window.getSelection()?.removeAllRanges()
        ui().beginEdit(id, caret)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (mode === 'read') ui().setActive(id)
        ui().setContextMenu({ x: e.clientX, y: e.clientY, id })
      }}
    >
      <span className="block-anchor" />

      {active && mode === 'read' && (
        <div className={`floating-toolbar${toolbarBelow ? ' below' : ''}`}>
          {selectionSize > 1 ? (
            <button
              className={`tool-btn${keyEcho === 'ai' ? ' pressed-echo' : ''}`}
              onClick={() => ui().openAIPrompt()}
              title="让 AI 处理选中的段落（空格）"
            >
              <IconSparkles />
              AI 处理 {selectionSize} 段
              <span className="kbd">空格</span>
            </button>
          ) : (
            <>
              <button
                className={`tool-btn${keyEcho === 'e' ? ' pressed-echo' : ''}`}
                onClick={() => ui().beginEdit(id)}
                title={image ? '改图注（E 或双击）' : '编辑（E 或双击）'}
              >
                <IconEdit />
                {image ? '图注' : '编辑'}
                <span className="kbd">E</span>
              </button>
              {image && (
                <button className="tool-btn" onClick={() => void replaceImage(id)} title="换一张图，图注不变">
                  换图
                </button>
              )}
              <button
                className={`tool-btn${keyEcho === 'ai' ? ' pressed-echo' : ''}`}
                onClick={() => ui().openAIPrompt()}
                title="让 AI 改这一段：润色、精简、扩写，或写下你的要求（空格）"
              >
                <IconSparkles />
                AI
                <span className="kbd">空格</span>
              </button>
              {block.versions.length > 1 && (
                <button
                  className="tool-btn"
                  onClick={() => ui().setVersionPanelId(versionPanelOpen ? null : id)}
                  title="版本历史"
                >
                  <IconHistory />
                  <span className="kbd">{block.versions.length}</span>
                </button>
              )}
            </>
          )}
        </div>
      )}

      {active && selectionSize <= 1 && (mode === 'read' || mode === 'edit') && (
        <div className="block-meta-line">
          <span>{image ? '图片' : `${countChars(editing?.draft ?? block.text)} 字`}</span>
          {pathText && <span>· {pathText}</span>}
          {mode === 'edit' ? (
            <span>· ↵ 分段 · Shift+↵ 换行 · Esc 完成</span>
          ) : (
            block.versions.length > 1 && <span>· {block.versions.length} 个版本</span>
          )}
        </div>
      )}

      <div ref={morphRef} className={`morph${ghost ? ' morphing' : ''}`}>
        <div className="morph-layer current">{renderMode(mode, false)}</div>
        {ghost && <div className="morph-layer leaving">{renderMode(ghost.from, true)}</div>}
      </div>
      <AIErrorStrip anchorId={id} />

      {menu &&
        createPortal(
          <div
            className="context-menu"
            style={clampMenu(menu.x, menu.y)}
            // portal 里的 React 事件仍会冒泡回卡片本身，必须拦住
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <MenuItem label={image ? '改图注' : '编辑'} kbd="E" onClick={() => (closeMenu(), ui().beginEdit(id))} />
            {image ? (
              <MenuItem label="换图…" onClick={() => (closeMenu(), void replaceImage(id))} />
            ) : (
              <>
                <MenuItem label="AI…" kbd="空格" onClick={() => (closeMenu(), void ui().openAIPrompt())} />
                <MenuItem
                  label="AI 续写"
                  onClick={() => {
                    closeMenu()
                    void runScope({ kind: 'paragraphs', blockIds: [id], anchorId: id, label: '这一段' }, null, 'continue')
                  }}
                />
                <MenuItem label="去 AI 味" onClick={() => (closeMenu(), void deflavorBlock(id))} />
              </>
            )}
            <div className="context-menu-sep" />
            {canMergeUp && (
              <MenuItem
                label="与上一段合并"
                onClick={() => {
                  closeMenu()
                  const res = useProjectStore.getState().mergeWithPrevious(id)
                  if (res) ui().setActive(res.id)
                }}
              />
            )}
            <MenuItem
              label="在下方插入段落"
              onClick={() => {
                closeMenu()
                const fresh = useProjectStore.getState().insertParagraphAfter(id)
                if (fresh) ui().beginEdit(fresh)
              }}
            />
            <MenuItem
              label="在下方插入图片…"
              onClick={() => {
                closeMenu()
                void pickImages().then((imgs) => insertImages(imgs, id))
              }}
            />
            {!image && (
              <MenuItem
                label="转为标题"
                onClick={() => {
                  closeMenu()
                  const level = Math.min(6, parentLevel + 1)
                  useProjectStore.getState().convertBlock(id, 'heading', level)
                }}
              />
            )}
            <div className="context-menu-sep" />
            {block.versions.length > 1 && (
              <MenuItem
                label="版本历史"
                kbd={`${block.versions.length} 版`}
                onClick={() => (closeMenu(), ui().setVersionPanelId(id))}
              />
            )}
            {!image && (
              <MenuItem
                label="复制文本"
                onClick={() => {
                  closeMenu()
                  void navigator.clipboard?.writeText(block.text)
                }}
              />
            )}
            <MenuItem
              label={image ? '删除图片' : '删除段落'}
              danger
              onClick={() => {
                closeMenu()
                useProjectStore.getState().removeBlock(id)
                ui().pushToast({
                  kind: 'info',
                  text: image ? '图片已删除' : '段落已删除',
                  actionLabel: '撤销',
                  onAction: () => useProjectStore.getState().undo(),
                  duration: 5000,
                })
              }}
            />
          </div>,
          document.body
        )}

      {versionPanelOpen && (
        <VersionPopover
          block={block}
          onClose={() => ui().setVersionPanelId(null)}
          onRestore={(index) => {
            ui().setVersionPanelId(null)
            useProjectStore.getState().rollback(id, index)
          }}
        />
      )}
    </div>
  )
})

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, reminder: 0 }

/**
 * 正文的高亮：AI 选区优先；否则是 AI 味面板开着时的命中（重叠处显示最重的级别，
 * 所以按级别从轻到重排，后面的盖住前面的）。
 */
function highlightsOf(range: [number, number] | null, hits: FlavorHit[]): Highlight[] {
  if (range) return [{ from: range[0], to: range[1], className: 'ai-mark' }]
  return [...hits]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .map((h) => ({
      from: h.start,
      to: h.end,
      className: `flavor-mark sev-${h.severity}`,
      title: `${h.name}：${adviceOf(h.rule) ?? ''}`,
    }))
}

/** 段落文字：Markdown 模式下渲染语法，并叠加高亮 */
function ParagraphText({ text, range, hits }: { text: string; range: [number, number] | null; hits: FlavorHit[] }) {
  const markdown = useUIStore((s) => s.markdown)
  return (
    <p className={`prose block-text${markdown ? ' md-rendered' : ''}`}>
      {text ? (
        <MdText text={text} mode="rendered" plain={!markdown} highlights={highlightsOf(range, hits)} />
      ) : (
        <span className="placeholder">空段落</span>
      )}
    </p>
  )
}

/** 段内片段的修改：把前后没改的部分补上，对照时能看到整段 */
function opsInContext(s: Suggestion, paragraph: string): DiffOp[] {
  const range = s.target.range
  if (!range) return s.diff
  const before = paragraph.slice(0, range[0])
  const after = paragraph.slice(range[1])
  return [
    ...(before ? [{ op: 'keep' as const, text: before }] : []),
    ...s.diff,
    ...(after ? [{ op: 'keep' as const, text: after }] : []),
  ]
}

/**
 * 编辑框按键：回车分段、Shift+回车换行、段首退格合并、段尾 Delete 合并、
 * 段首 ↑ / 段尾 ↓ 跨段、Esc 或 Ctrl+回车完成。输入法组字期间一律不拦截。
 */
export function handleEditorKey(
  e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  id: string
): void {
  if (isImeKey(e.nativeEvent)) return
  const ui = useUIStore.getState()
  if (ui.editing?.id !== id) return
  if (formatShortcut(e)) return
  const el = e.currentTarget
  const start = el.selectionStart ?? 0
  const end = el.selectionEnd ?? 0
  const collapsed = start === end
  const handled = (() => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      ui.confirmEdit()
      return true
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      ui.splitAtCaret(start, end)
      return true
    }
    if (e.key === 'Backspace' && collapsed && start === 0) return ui.mergeUpFromEdit()
    if (e.key === 'Delete' && collapsed && start === el.value.length) return ui.mergeDownFromEdit()
    if (e.key === 'ArrowUp' && collapsed && start === 0) return ui.moveEdit(-1)
    if (e.key === 'ArrowDown' && collapsed && start === el.value.length) return ui.moveEdit(1)
    return false
  })()
  if (handled) {
    e.preventDefault()
    // 已在这里处理，别再让全局快捷键重复处理（例如 Esc 会顺带取消选中）
    e.stopPropagation()
  }
}

/** 图注输入框：回车 / Esc 完成；首尾按 ↑ / ↓ 跨到相邻的块 */
function handleCaptionKey(e: React.KeyboardEvent<HTMLInputElement>, id: string): void {
  if (isImeKey(e.nativeEvent)) return
  const ui = useUIStore.getState()
  if (ui.editing?.id !== id) return
  const el = e.currentTarget
  const at = el.selectionStart ?? 0
  const handled =
    e.key === 'Escape' || e.key === 'Enter'
      ? (ui.confirmEdit(), true)
      : e.key === 'ArrowUp' && at === 0
        ? ui.moveEdit(-1)
        : e.key === 'ArrowDown' && at === el.value.length
          ? ui.moveEdit(1)
          : false
  if (handled) {
    e.preventDefault()
    e.stopPropagation()
  }
}

/** 换图：图注不变，图片换成新选的那张 */
async function replaceImage(id: string): Promise<void> {
  const [img] = await pickImages()
  const ctx = currentAssetCtx()
  const block = ctx && useProjectStore.getState().data?.blocks.find((b) => b.id === id)
  const current = block ? parseImage(block.text) : null
  if (!img || !ctx || !current) return
  const src = await putAsset(ctx, img.bytes, extOf(img.name) || 'png')
  useProjectStore.getState().editBlock(id, imageLine(current.caption, src), 'manual')
}

export function MenuItem({
  label,
  kbd,
  danger,
  onClick,
}: {
  label: string
  kbd?: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button className={`context-menu-item${danger ? ' danger' : ''}`} onClick={onClick}>
      {label}
      {kbd && <span className="kbd">{kbd}</span>}
    </button>
  )
}

/** 右键菜单贴着鼠标出现，但不越出窗口 */
export function clampMenu(x: number, y: number): { left: number; top: number } {
  const w = 200
  const h = 340
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
  }
}

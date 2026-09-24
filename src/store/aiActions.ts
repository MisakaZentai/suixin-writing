/**
 * AI 编排：按作用范围组织请求 → 流式展示 → 落为建议 → 就地打开对照确认。
 * 失败时把错误显示在对应的块上（可重试），而不是一闪而过的提示条。
 */
import type { SuggestionTarget, SuggestionTask } from '../types'
import { Typewriter } from '../lib/typewriter'
import {
  buildAIContext,
  chatStream,
  checkAlignment,
  continueMessages,
  deflavorMessages,
  deflavorRetryMessages,
  expandMessages,
  inferOutline,
  reviewDocument,
  reviseMessages,
  rewriteMessages,
  type AIConfig,
  type ChatMessage,
  type DeflavorMode,
} from '../lib/ai'
import { getBlock, headingPaths, indexOfBlock, isStale, sectionBodyIds, targetText } from '../lib/doc'
import { makeHeading } from '../lib/markdown'
import { isImageText, preserveImages } from '../lib/images'
import { analyzeText, countChars, dialogueSpans, flavorDelta, type FlavorHit, type FlavorOptions } from '../lib/flavor'
import { adviceOf, flavorOptions } from '../lib/flavor/project'
import type { ProjectData } from '../types'
import { useProjectStore } from './projectStore'
import { useAIConfigStore } from './aiConfigStore'
import { useUIStore, type AIScope, type Placement } from './uiStore'

const project = () => useProjectStore.getState()
const ui = () => useUIStore.getState()

/* ── 快捷指令与最近指令 ───────────────────────────────── */

export interface PromptChip {
  label: string
  /** null = 不带意见的润色重写 */
  instruction: string | null
  mode?: 'edit' | 'continue' | 'deflavor'
}

const CHIP_REWRITE: PromptChip = { label: '润色', instruction: null }
const CHIP_CONTINUE: PromptChip = { label: '续写', instruction: null, mode: 'continue' }

export function chipsFor(scope: AIScope): PromptChip[] {
  if (scope.kind === 'section' && !scope.blockIds.length) {
    return [{ label: '写这一节', instruction: null }]
  }
  const common: PromptChip[] = [
    CHIP_REWRITE,
    { label: '精简', instruction: '精简表达，删去重复与冗余，篇幅压缩到原来的三分之二左右，意思不变。' },
    { label: '扩写', instruction: '在不改变原意的前提下扩写，补充细节、画面或论证，篇幅扩大到原来的一倍半左右。' },
    { label: '更口语', instruction: '改得更口语、更自然，像当面讲给朋友听。' },
    { label: '更正式', instruction: '改得更正式、书面、严谨。' },
    { label: '去 AI 味', instruction: null, mode: 'deflavor' },
  ]
  return scope.kind === 'range' ? common : [...common, CHIP_CONTINUE]
}

const RECENT_KEY = 'suixin:recent-instructions'

export function recentInstructions(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, 4) : []
  } catch {
    return []
  }
}

function rememberInstruction(text: string): void {
  try {
    const list = [text, ...recentInstructions().filter((x) => x !== text)].slice(0, 4)
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

/* ── 入口 ─────────────────────────────────────────── */

/** 提交 AI 指令框：chip 优先；否则用输入框里的文字（留空 = 润色） */
export async function submitAIPrompt(chip?: PromptChip): Promise<void> {
  const prompt = ui().aiPrompt
  if (!prompt) return
  const typed = prompt.draft.trim()
  const instruction = chip ? chip.instruction : typed || null
  const mode = chip?.mode ?? 'edit'
  if (!chip && typed) rememberInstruction(typed)
  useUIStore.setState({ aiPrompt: null, textRange: null, selection: null })
  window.getSelection()?.removeAllRanges()
  if (mode === 'deflavor') await deflavorScope(prompt.scope)
  else await runScope(prompt.scope, instruction, mode)
}

export async function runScope(
  scope: AIScope,
  instruction: string | null,
  mode: 'edit' | 'continue' = 'edit'
): Promise<void> {
  const data = project().data
  if (!data) return
  if (ui().stream) {
    ui().pushToast({ kind: 'info', text: '已有生成任务进行中' })
    return
  }
  const retry = () => void runScope(scope, instruction, mode)

  // 续写，或给还没有正文的章节写正文：插在范围末尾
  if (mode === 'continue' || (scope.kind === 'section' && !scope.blockIds.length)) {
    const after = scope.blockIds[scope.blockIds.length - 1] ?? scope.headingId ?? null
    const target: SuggestionTarget = { blockIds: [], insertAfter: after }
    const config = await readConfig(scope.anchorId)
    if (!config) return
    const ctx = buildAIContext(data, target)
    const heading = scope.headingId ? getBlock(data, scope.headingId) : undefined
    const messages =
      mode === 'continue'
        ? continueMessages(ctx, instruction)
        : withExtra(expandMessages(ctx, heading?.text ?? ''), instruction)
    await runStream(config, messages, {
      target,
      original: '',
      instruction: instruction ?? (mode === 'continue' ? '续写' : `写这一节：${heading?.text ?? ''}`),
      task: mode === 'continue' ? 'continue' : 'expand',
      placement: { anchorId: after, blockIds: [], insert: true },
      errorAnchor: scope.anchorId,
      retry,
    })
    return
  }

  const target: SuggestionTarget = { blockIds: scope.blockIds, range: scope.range ?? null }
  const original = targetText(data, target)
  if (original == null) return
  // 只有图片：内置 AI 看不到图，改写只会弄坏图片行
  if (scope.blockIds.every((id) => isImageText(getBlock(data, id)?.text ?? ''))) {
    ui().setAIError({ anchorId: scope.anchorId, message: '内置 AI 看不到图片。改图注按 E；需要换图可以「交给 Agent」' })
    return
  }
  if (!original.trim()) {
    ui().pushToast({ kind: 'info', text: '这里还是空的，先写点什么吧' })
    return
  }
  const config = await readConfig(scope.anchorId)
  if (!config) return
  const ctx = buildAIContext(data, target)
  const messages = instruction ? reviseMessages(ctx, instruction) : rewriteMessages(ctx)
  ui().setActive(scope.blockIds[0])
  await runStream(config, messages, {
    target,
    original,
    instruction,
    task: instruction ? 'revise' : 'rewrite',
    placement: { anchorId: scope.blockIds[0], blockIds: scope.blockIds, insert: false },
    errorAnchor: scope.blockIds[0],
    retry,
  })
}

/* ── 去 AI 味 ─────────────────────────────────────── */

/**
 * 去 AI 味：只处理这里实际命中的套路（带着位置与改法交给模型），附上作者自己的干净段落示范语感；
 * 改完用本地规则复检，没通过就带着剩下的问题自动再改一版（作为第二个候选），最终仍由作者确认。
 */
export async function deflavorScope(scope: AIScope, mode: DeflavorMode = 'sentences'): Promise<void> {
  const data = project().data
  if (!data) return
  if (ui().stream) {
    ui().pushToast({ kind: 'info', text: '已有生成任务进行中' })
    return
  }
  const target: SuggestionTarget = { blockIds: scope.blockIds, range: scope.range ?? null }
  const original = targetText(data, target)
  if (original == null || !original.trim() || !scope.blockIds.length) return
  const plan = deflavorPlan(data, target, original, mode)
  if (!plan) {
    ui().pushToast({ kind: 'info', text: '这里没有发现明显的 AI 腔' })
    return
  }
  const config = await readConfig(scope.anchorId)
  if (!config) return
  ui().setActive(scope.blockIds[0])
  await runStream(config, plan.messages, {
    target,
    original,
    instruction: plan.instruction,
    task: 'deflavor',
    placement: { anchorId: scope.blockIds[0], blockIds: scope.blockIds, insert: false },
    errorAnchor: scope.blockIds[0],
    retry: () => void deflavorScope(scope, mode),
    verify: plan.verify,
    retryMessages: plan.retryMessages,
  })
}

/** 去掉一段的 AI 味（面板与段落菜单用） */
export function deflavorBlock(blockId: string): Promise<void> {
  return deflavorScope({ kind: 'paragraphs', blockIds: [blockId], anchorId: blockId, label: '这一段' })
}

function deflavorPlan(data: ProjectData, target: SuggestionTarget, original: string, mode: DeflavorMode) {
  const opts = flavorOptions(data)
  const hits = uniqueHits(analyzeText(original, opts).hits)
  if (!hits.length) return null
  const targets = hits.map((h) => ({ quote: h.text, name: h.name, advice: adviceOf(h.rule) ?? '' }))
  const messages = deflavorMessages(buildAIContext(data, target), targets, {
    mode,
    samples: authorSamples(data, target.blockIds),
  })
  return {
    messages,
    instruction: `去 AI 味：${[...new Set(hits.map((h) => h.name))].join('、')}`,
    verify: (proposed: string) => deflavorProblems(original, proposed, hits, opts),
    retryMessages: (previous: string, problems: string[]) => deflavorRetryMessages(messages, previous, problems),
  }
}

function uniqueHits(hits: FlavorHit[]): FlavorHit[] {
  const seen = new Set<string>()
  return hits.filter((h) => {
    const k = `${h.rule}:${h.start}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 作者自己的干净段落（离目标最近的两段）：示范语感，不照抄内容 */
function authorSamples(data: ProjectData, exclude: string[]): string[] {
  const skip = new Set(exclude)
  const at = data.blocks.findIndex((b) => b.id === exclude[0])
  const opts = flavorOptions(data)
  return data.blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.type === 'paragraph' && !skip.has(b.id) && !isImageText(b.text))
    .filter(({ b }) => {
      const n = countChars(b.text)
      return n >= 40 && n <= 300 && analyzeText(b.text, opts).hits.length === 0
    })
    .sort((x, y) => Math.abs(x.i - at) - Math.abs(y.i - at))
    .slice(0, 2)
    .map(({ b }) => b.text)
}

/** 本地复检：目标命中还在、带进新套路、篇幅变化过大、数字或对白被改 */
export function deflavorProblems(original: string, proposed: string, targets: FlavorHit[], opts: FlavorOptions): string[] {
  const problems: string[] = []
  const delta = flavorDelta(original, proposed, opts)
  const targetRules = new Set(targets.map((h) => h.rule))
  for (const h of delta.kept.filter((x) => targetRules.has(x.rule))) {
    problems.push(`「${h.text}」（${h.name}）还在。${adviceOf(h.rule) ?? ''}`)
  }
  for (const h of delta.added) {
    problems.push(`新增了「${h.text}」（${h.name}），不要用一种套路替换另一种`)
  }
  const a = countChars(original)
  const b = countChars(proposed)
  if (a >= 20 && (b < a * 0.7 || b > a * 1.3)) problems.push(`篇幅变化超过三成（原文 ${a} 字，这一版 ${b} 字）`)
  const numbers = (t: string) => new Set(t.match(/\d+(?:\.\d+)?/g) ?? [])
  const lost = [...numbers(original)].filter((n) => !numbers(proposed).has(n))
  if (lost.length) problems.push(`数字 ${lost.join('、')} 不见了，事实与数据不能改`)
  const targeted = (s: number, e: number) => targets.some((h) => h.start < e && s < h.end)
  for (const [s, e] of dialogueSpans(original)) {
    const line = original.slice(s, e)
    if (!targeted(s, e) && !proposed.includes(line)) problems.push(`对白 ${line.slice(0, 20)} 被改动了，对白保持原样`)
  }
  return problems
}

/** 扩写本节：有正文就整节改写扩充，没有就新写 */
export async function expandSection(headingId: string): Promise<void> {
  const data = project().data
  const heading = data && getBlock(data, headingId)
  if (!data || !heading || heading.type !== 'heading') return
  if (ui().stream) {
    ui().pushToast({ kind: 'info', text: '已有生成任务进行中' })
    return
  }
  const body = sectionBodyIds(data.blocks, headingId)
  const target: SuggestionTarget = body.length ? { blockIds: body } : { blockIds: [], insertAfter: headingId }
  const config = await readConfig(headingId)
  if (!config) return
  const ctx = buildAIContext(data, target)
  await runStream(config, expandMessages(ctx, heading.text), {
    target,
    original: ctx.target,
    instruction: `扩写本节：${heading.text}`,
    task: 'expand',
    placement: body.length
      ? { anchorId: body[0], blockIds: body, insert: false }
      : { anchorId: headingId, blockIds: [], insert: true },
    errorAnchor: headingId,
    retry: () => void expandSection(headingId),
  })
}

/** 检查本节：只产出建议，不改正文 */
export async function checkSection(headingId: string): Promise<void> {
  const data = project().data
  const heading = data && getBlock(data, headingId)
  if (!data || !heading || heading.type !== 'heading') return
  const body = sectionBodyIds(data.blocks, headingId)
  if (!body.length) {
    ui().pushToast({ kind: 'info', text: '这一节还没有正文' })
    return
  }
  const config = await readConfig(headingId)
  if (!config) return
  ui().pushToast({ kind: 'info', text: `正在检查「${heading.text}」…` })
  try {
    const paragraphs = body.map((id) => getBlock(data, id)?.text ?? '')
    const issues = await checkAlignment(config, data, heading.text, paragraphs)
    let created = 0
    project().mutate((d) => {
      for (const issue of issues) {
        const id = body[issue.index - 1]
        const b = id ? getBlock(d, id) : undefined
        if (!b) continue
        d.suggestions.push({
          id: `s_note_${Date.now().toString(36)}_${created}`,
          kind: 'note',
          target: { blockIds: [b.id] },
          instruction: issue.advice,
          issue: issue.issue,
          original: b.text,
          proposed: '',
          diff: [],
          state: 'pending',
          createdAt: new Date().toISOString(),
        })
        created++
      }
    })
    if (created) ui().setSuggestionsOpen(true)
    ui().pushToast({
      kind: created ? 'success' : 'info',
      text: created ? `发现 ${created} 条建议，见「待办」` : '这一节与标题一致，没有发现问题',
    })
  } catch (e) {
    ui().setAIError({ anchorId: headingId, message: errorText(e), retry: () => void checkSection(headingId) })
  }
}

/** AI 划分章节：先给出提案，作者确认后才插入标题 */
export async function inferSections(): Promise<void> {
  const data = project().data
  if (!data) return
  const paragraphs = data.blocks.filter((b) => b.type === 'paragraph' && b.text.trim())
  if (!paragraphs.length) return
  const config = await readConfig(null)
  if (!config) return
  ui().pushToast({ kind: 'info', text: 'AI 正在划分章节…' })
  try {
    const { title, headings } = await inferOutline(
      config,
      paragraphs.map((p) => p.text)
    )
    if (!headings.length) {
      ui().pushToast({ kind: 'info', text: 'AI 没有给出可用的章节划分' })
      return
    }
    ui().setOutlineProposal({
      title: title.trim(),
      items: [...headings]
        .sort((a, b) => a.before - b.before)
        .map((h) => {
          const p = paragraphs[h.before - 1]
          return {
            beforeId: p.id,
            level: Math.min(4, Math.max(2, Math.round(h.level))),
            title: h.title.trim(),
            snippet: p.text.slice(0, 40),
            include: true,
          }
        }),
    })
  } catch (e) {
    ui().pushToast({ kind: 'error', text: `划分章节失败：${errorText(e)}`, duration: 8000 })
  }
}

/** 按提案插入标题 */
export function applyOutlineProposal(): void {
  const proposal = ui().outlineProposal
  if (!proposal) return
  const chosen = proposal.items.filter((i) => i.include && i.title.trim())
  ui().setOutlineProposal(null)
  if (!chosen.length) return
  project().mutate((d) => {
    // 从后往前插，前面的位置不受影响
    for (const item of [...chosen].reverse()) {
      const at = indexOfBlock(d, item.beforeId)
      if (at >= 0) d.blocks.splice(at, 0, makeHeading(item.level, item.title.trim()))
    }
    if (proposal.title && d.meta.title === '未命名文稿') {
      d.meta.title = proposal.title
      d.meta.titleAsHeading = true
    }
  })
  ui().pushToast({
    kind: 'success',
    text: `已插入 ${chosen.length} 个章节标题`,
    actionLabel: '撤销',
    onAction: () => project().undo(),
    duration: 6000,
  })
}

/** 全文检查：逐段给出建议，放进"待办" */
export async function reviewWholeDocument(): Promise<void> {
  const data = project().data
  if (!data) return
  if (!data.blocks.some((b) => b.type === 'paragraph' && b.text.trim())) return
  const config = await readConfig(null)
  if (!config) return
  ui().pushToast({ kind: 'info', text: 'AI 正在通读全文…', duration: 4000 })
  try {
    const { issues, paragraphIds } = await reviewDocument(config, data)
    const total = data.blocks.filter((b) => b.type === 'paragraph' && b.text.trim()).length
    let created = 0
    project().mutate((d) => {
      for (const issue of issues) {
        const b = getBlock(d, paragraphIds[issue.index - 1] ?? '')
        if (!b) continue
        d.suggestions.push({
          id: `s_note_${Date.now().toString(36)}_${created}`,
          kind: 'note',
          target: { blockIds: [b.id] },
          instruction: issue.advice,
          issue: issue.issue,
          original: b.text,
          proposed: '',
          diff: [],
          state: 'pending',
          createdAt: new Date().toISOString(),
        })
        created++
      }
    })
    if (created) ui().setSuggestionsOpen(true)
    const partial = paragraphIds.length < total ? `（篇幅较长，只检查了前 ${paragraphIds.length} 段）` : ''
    ui().pushToast({
      kind: created ? 'success' : 'info',
      text: created ? `发现 ${created} 条建议，见「待办」${partial}` : `没有发现明显问题${partial}`,
      duration: 5000,
    })
  } catch (e) {
    ui().pushToast({ kind: 'error', text: `全文检查失败：${errorText(e)}`, duration: 8000 })
  }
}

/** 检查建议 → 带着建议内容打开 AI 指令框 */
export function adoptNote(suggestionId: string): void {
  const data = project().data
  const s = data?.suggestions.find((x) => x.id === suggestionId)
  if (!s || !s.target.blockIds.length) return
  project().dismissSuggestion(suggestionId)
  const id = s.target.blockIds[0]
  ui().requestLocate(id)
  ui().setActive(id)
  ui().openAIPrompt(
    { kind: 'paragraphs', blockIds: [id], anchorId: id, label: '这一段' },
    s.instruction ?? ''
  )
}

/** 再来一版：同样的范围与要求重新生成，结果作为新候选 */
export async function regenerate(suggestionId: string): Promise<void> {
  const data = project().data
  const sg = data?.suggestions.find((s) => s.id === suggestionId)
  if (!data || !sg || sg.kind !== 'ai_diff' || ui().stream) return
  if (isStale(data, sg)) {
    ui().pushToast({ kind: 'info', text: '原文已被改动，请重新选择后再让 AI 处理' })
    return
  }
  const insert = sg.target.blockIds.length === 0
  const anchor = insert ? sg.target.insertAfter ?? null : sg.target.blockIds[0]
  const config = await readConfig(anchor)
  if (!config) return
  const ctx = buildAIContext(data, sg.target)
  const task: SuggestionTask = sg.task ?? (insert ? 'continue' : sg.instruction ? 'revise' : 'rewrite')
  let messages: ChatMessage[]
  let verify: ((p: string) => string[]) | undefined
  let retryMessages: ((prev: string, problems: string[]) => ChatMessage[]) | undefined
  if (task === 'deflavor') {
    const plan = deflavorPlan(data, sg.target, sg.original, 'sentences')
    if (!plan) {
      ui().pushToast({ kind: 'info', text: '原文里已经没有明显的 AI 腔' })
      return
    }
    messages = plan.messages
    verify = plan.verify
    retryMessages = plan.retryMessages
  } else if (task === 'rewrite') messages = rewriteMessages(ctx)
  else if (task === 'revise') messages = reviseMessages(ctx, sg.instruction ?? '')
  else if (task === 'continue') messages = continueMessages(ctx, sg.instruction === '续写' ? null : sg.instruction)
  else {
    const heading = insert
      ? getBlock(data, sg.target.insertAfter ?? '')
      : (headingPaths(data.blocks).get(sg.target.blockIds[0]) ?? []).slice(-1)[0]
    messages = expandMessages(ctx, heading?.text ?? '')
  }
  useUIStore.setState({ diff: null })
  await runStream(config, messages, {
    target: sg.target,
    original: sg.original,
    instruction: sg.instruction,
    task,
    placement: { anchorId: anchor, blockIds: sg.target.blockIds, insert },
    errorAnchor: anchor,
    retry: () => void regenerate(suggestionId),
    suggestionId,
    verify,
    retryMessages,
  })
}

export function abortAI(): void {
  const { stream } = ui()
  if (!stream) return
  stream.controller.abort()
  stream.tw.finish()
}

/* ── 内部 ─────────────────────────────────────────── */

function withExtra(messages: ChatMessage[], instruction: string | null): ChatMessage[] {
  if (!instruction) return messages
  const last = messages[messages.length - 1]
  return [...messages.slice(0, -1), { ...last, content: `${last.content}\n【额外要求】${instruction}` }]
}

function errorText(e: unknown): string {
  return (e as Error)?.message || '未知错误'
}

/**
 * 只读应用级 AI 服务设置——工程文件里的接口地址一律不用，
 * 避免把本机 Key 发往陌生文件指定的地址。没配好时在块上就地提示。
 */
async function readConfig(anchorId: string | null): Promise<AIConfig | null> {
  const config = await useAIConfigStore.getState().resolve()
  if (config) return config
  if (anchorId) {
    ui().setAIError({ anchorId, message: '还没有配置 AI 服务', retry: () => ui().setSettingsOpen(true) })
  } else {
    ui().pushToast({
      kind: 'error',
      text: '还没有配置 AI 服务',
      actionLabel: '去设置',
      duration: 6000,
      onAction: () => ui().setSettingsOpen(true),
    })
  }
  return null
}

/** 边收边展示 → 落为建议 → 打开对照确认 */
async function runStream(
  config: AIConfig,
  messages: ChatMessage[],
  opts: {
    target: SuggestionTarget
    original: string
    instruction: string | null
    task: SuggestionTask
    placement: Placement
    errorAnchor: string | null
    retry: () => void
    /** "再来一版"：结果作为已有建议的新候选 */
    suggestionId?: string
    /** 生成后本地复检：返回问题清单，空表示通过 */
    verify?: (proposed: string) => string[]
    /** 复检没通过时，带着问题再改一版的请求（只重试一次，结果作为第二个候选） */
    retryMessages?: (previous: string, problems: string[]) => ChatMessage[]
  }
): Promise<void> {
  // 同一时间只跑一个生成任务：所有入口（段落、扩写本节、再来一版…）都在这里把关
  if (useUIStore.getState().stream) {
    ui().pushToast({ kind: 'info', text: '已有生成任务进行中' })
    return
  }
  const controller = new AbortController()
  /** 只清理自己这一次的生成状态，不误伤之后发起的任务 */
  const clearMine = () => {
    if (useUIStore.getState().stream?.controller === controller) useUIStore.setState({ stream: null })
  }
  const reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const tw = new Typewriter(reduced)
  useUIStore.setState({
    stream: { ...opts.placement, tw, controller, instruction: opts.instruction },
    aiError: null,
  })
  let received = ''
  let aborted = false
  try {
    for await (const chunk of chatStream(config, messages, controller.signal)) {
      received += chunk
      tw.push(chunk)
    }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') aborted = true
    else {
      tw.abort()
      clearMine()
      if (opts.errorAnchor) {
        ui().setAIError({ anchorId: opts.errorAnchor, message: errorText(e), retry: opts.retry })
      } else {
        ui().pushToast({ kind: 'error', text: `AI 处理失败：${errorText(e)}`, duration: 8000 })
      }
      return
    }
  }
  tw.finish()
  // 改写的范围里有图片：模型漏掉的图片行放回原位
  const proposed = preserveImages(opts.original, received.trim())
  const done = (text: string, kind: 'info' | 'error' = 'info') => {
    clearMine()
    ui().pushToast({ kind, text })
  }
  if (aborted && proposed.length < 8) return done('已中断，没有采用任何结果')
  if (!proposed) return done('AI 没有返回内容，请重试')
  const data = project().data
  // 生成期间原文被改动：结果作废，免得覆盖新写的内容
  if (!data || targetText(data, opts.target) !== opts.original) {
    return done('原文在生成期间被改动，结果已丢弃', 'error')
  }
  if (proposed === opts.original.trim()) {
    done('AI 认为不需要改动')
    if (opts.suggestionId) ui().openDiff(opts.suggestionId)
    return
  }
  let suggestionId: string | null = opts.suggestionId ?? null
  if (suggestionId) project().setSuggestionProposed(suggestionId, proposed)
  else {
    suggestionId = project().addSuggestion({
      kind: 'ai_diff',
      target: opts.target,
      instruction: opts.instruction,
      original: opts.original,
      proposed,
      task: opts.task,
    })
  }
  clearMine()
  const problems = !aborted && suggestionId && opts.verify && opts.retryMessages ? opts.verify(proposed) : []
  if (problems.length && suggestionId && opts.retryMessages) {
    ui().pushToast({ kind: 'info', text: `复检发现 ${problems.length} 处问题，再改一版…`, duration: 3000 })
    await runStream(config, opts.retryMessages(proposed, problems), {
      ...opts,
      suggestionId,
      verify: undefined,
      retryMessages: undefined,
    })
    return
  }
  if (suggestionId) ui().openDiff(suggestionId)
  if (aborted) ui().pushToast({ kind: 'info', text: '已中断，可基于已生成的部分确认' })
}

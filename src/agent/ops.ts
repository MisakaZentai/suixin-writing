/**
 * Agent 操作注册表：命令行、MCP、实时桥共用同一份定义。
 *
 * 权限模型：
 * - 读操作随时可用；
 * - 文字修改（replace / insert / delete）默认落为"待确认建议"，由作者在 App 里拍板；
 *   作者为这篇文稿授权"直接修改"后，agent 显式请求 direct 才会直接写入；
 * - 结构修改（改标题、移动章节等）只能在 direct 下进行。
 */
import type { AgentTask, DocBlock, ProjectData, Suggestion } from '../types'
import type { FlavorBaseline } from '../lib/flavor/analyze'
import { claimTask, completeTask, isActive, tasksOf, type ClaimResult } from '../lib/tasks'
import { isImageText, parseImage } from '../lib/images'
import {
  addSuggestion,
  applySuggestion,
  countChars,
  dismissSuggestion,
  editBlock,
  getBlock,
  headingPaths,
  indexOfBlock,
  insertHeadingAfter,
  isStale,
  moveSection,
  removeBlock,
  sectionEnd,
  shiftSectionLevel,
  targetText,
  textToBlocks,
} from '../lib/doc'
import { exportMarkdown } from '../lib/project'
import { analyzeProject, flavorView, flavorWarning, textView } from '../lib/flavor/project'
import { BUILTIN, getBaselineStore } from '../lib/flavor/baselines'
import { computeDiff } from '../lib/diff'
import { AgentError } from './errors'
import { POSITION_SCHEMA, TARGET_SCHEMA, type JSONSchema } from './schema'
import { findQuote, pathOf, resolveHeading, resolvePosition, resolveTarget, type TargetSpec } from './target'

export type AgentMode = 'propose' | 'direct'

export interface AgentContext {
  /** agent 的显示名，如 "Claude Code" */
  author: string
  mode: AgentMode
  /** 本次调用的变更集 id：同一次提交的建议可以整组接受 / 放弃 */
  changeset: string
  /**
   * 本次调用里已提出的修改（按目标段落）。提建议时正文不变，同一段的第二处修改
   * 若各自成条会互相作废 / 错位，所以合并成一条段落级建议。
   */
  edits?: Map<string, { suggestionId: string; whole: boolean; ranges: { start: number; end: number; text: string }[] }>
  /** 指定 AI 味基线；不传则按文稿的选择 / 默认基线（见 lib/flavor/baselines.ts），null 为内置基线 */
  baseline?: FlavorBaseline | null
}

export interface OpSpec {
  name: string
  summary: string
  /** 会修改文稿 */
  write: boolean
  /** 只能在作者授权直接修改后使用 */
  directOnly?: boolean
  params: JSONSchema
  run: (d: ProjectData, params: Record<string, unknown>, ctx: AgentContext) => unknown
}

const obj = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const WHY: JSONSchema = { type: 'string', description: '修改理由，会显示给作者' }

/* ── 读 ─────────────────────────────────────────── */

function blockView(d: ProjectData, b: DocBlock, paths: ReturnType<typeof headingPaths>) {
  if (b.type === 'heading') return { id: b.id, type: 'heading', level: b.level, text: b.text }
  const section = (paths.get(b.id) ?? []).map((h) => h.text).join(' / ') || undefined
  // 图片段落：给出图注与路径（命令行 / App 会补上绝对路径与尺寸），text 保留原样以便定位
  const img = parseImage(b.text)
  if (img) return { id: b.id, type: 'image', caption: img.caption, src: img.src, text: b.text, section }
  return { id: b.id, type: 'paragraph', text: b.text, section }
}

function suggestionView(d: ProjectData, s: Suggestion) {
  return {
    id: s.id,
    kind: s.kind,
    state: s.state,
    author: s.author?.name ?? (s.kind === 'ai_diff' ? '内置 AI' : undefined),
    changeset: s.changeset,
    why: s.why,
    instruction: s.instruction,
    issue: s.issue,
    target: s.target,
    original: s.original,
    proposed: s.kind === 'ai_diff' ? s.proposed : undefined,
    stale: s.state === 'pending' && s.kind === 'ai_diff' ? isStale(d, s) : undefined,
  }
}

const readOps: OpSpec[] = [
  {
    name: 'info',
    summary: '文稿概况：标题、段落数、字数、待处理建议、agent 权限',
    write: false,
    params: obj({}),
    run: (d) => {
      const paragraphs = d.blocks.filter((b) => b.type === 'paragraph' && !isImageText(b.text))
      const pending = d.suggestions.filter((s) => s.state === 'pending')
      return {
        title: d.meta.title,
        schema: d.schema,
        access: d.meta.agentAccess ?? 'propose',
        paragraphs: paragraphs.length,
        headings: d.blocks.filter((b) => b.type === 'heading').length,
        images: d.blocks.filter((b) => b.type === 'paragraph' && isImageText(b.text)).length,
        chars: paragraphs.reduce((n, b) => n + countChars(b.text), 0),
        brief: d.brief || undefined,
        pending: {
          edits: pending.filter((s) => s.kind === 'ai_diff').length,
          notes: pending.filter((s) => s.kind === 'note').length,
        },
        tasks: tasksOf(d).filter(isActive).length,
      }
    },
  },
  {
    name: 'outline',
    summary: '大纲：每个标题的 id、层级、下辖段落数、图片数与字数',
    write: false,
    params: obj({}),
    run: (d) => {
      const out: { id: string; level: number; title: string; paragraphs: number; images?: number; chars: number }[] = []
      d.blocks.forEach((b, i) => {
        if (b.type !== 'heading') return
        const body = d.blocks.slice(i + 1, sectionEnd(d.blocks, i)).filter((x) => x.type === 'paragraph')
        const images = body.filter((x) => isImageText(x.text)).length
        out.push({
          id: b.id,
          level: b.level,
          title: b.text,
          paragraphs: body.length - images,
          ...(images ? { images } : {}),
          chars: body.reduce((n, x) => n + countChars(x.text), 0),
        })
      })
      const first = d.blocks.findIndex((b) => b.type === 'heading')
      const preface = (first < 0 ? d.blocks : d.blocks.slice(0, first)).filter((b) => b.type === 'paragraph').length
      return { title: d.meta.title, preface, headings: out }
    },
  },
  {
    name: 'read',
    summary: '读取正文（按块，带 id）；可限定章节、分页；format=markdown 则返回 Markdown 文本',
    write: false,
    params: obj({
      section: { type: 'string', description: '只读这一节（标题或标题 id，含子节）' },
      from: { type: 'string', description: '从这一块开始（分页续读时传上次返回的 next）' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回多少块，默认 60' },
      format: { type: 'string', enum: ['blocks', 'markdown'] },
    }),
    run: (d, p) => {
      let blocks = d.blocks
      if (p.section) {
        const h = resolveHeading(d, p.section as string)
        const i = indexOfBlock(d, h.id)
        blocks = d.blocks.slice(i, sectionEnd(d.blocks, i))
      }
      if (p.format === 'markdown' && !p.section && !p.from) return { markdown: exportMarkdown(d) }
      let start = 0
      if (p.from) {
        start = blocks.findIndex((b) => b.id === p.from)
        if (start < 0) throw new AgentError('NOT_FOUND', `范围内找不到块 ${p.from}`)
      }
      const limit = (p.limit as number | undefined) ?? 60
      const page = blocks.slice(start, start + limit)
      const next = blocks[start + limit]?.id
      if (p.format === 'markdown') {
        const md = page
          .map((b) => (b.type === 'heading' ? `${'#'.repeat(b.level)} ${b.text}` : b.text))
          .join('\n\n')
        return { markdown: md, next }
      }
      const paths = headingPaths(d.blocks)
      return { blocks: page.map((b) => blockView(d, b, paths)), next, total: blocks.length }
    },
  },
  {
    name: 'find',
    summary: '查找文字（逐字匹配或正则），返回所在段落 id、位置与上下文',
    write: false,
    params: obj(
      {
        text: { type: 'string', description: '要找的文字' },
        regex: { type: 'boolean', description: 'text 按正则表达式解释' },
        in: { type: 'string', description: '只在这一段（id）或这一节（标题 / id）里找' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      ['text']
    ),
    run: (d, p) => {
      const limit = (p.limit as number | undefined) ?? 30
      let matches: { block: string; start: number; end: number; context: string }[]
      if (p.regex) {
        let re: RegExp
        try {
          re = new RegExp(p.text as string, 'g')
        } catch (e) {
          throw new AgentError('INVALID_PARAMS', `正则表达式无效：${(e as Error).message}`)
        }
        matches = []
        for (const b of d.blocks) {
          if (b.type !== 'paragraph') continue
          if (p.in && b.id !== p.in && !pathOf(d, b.id).split(' / ').includes(p.in as string)) continue
          for (const m of b.text.matchAll(re)) {
            if (m[0] === '') continue
            const s = m.index ?? 0
            matches.push({
              block: b.id,
              start: s,
              end: s + m[0].length,
              context: b.text.slice(Math.max(0, s - 16), s + m[0].length + 16),
            })
          }
        }
      } else {
        matches = findQuote(d, p.text as string, p.in as string | undefined)
      }
      return {
        count: matches.length,
        matches: matches.slice(0, limit).map((m, i) => ({ occurrence: i + 1, ...m, section: pathOf(d, m.block) || undefined })),
      }
    },
  },
  {
    name: 'flavor',
    summary:
      'AI 味检查：整篇 / 某一节 / 某几段的 AI 味指数（相对基线的超标程度，0–100）、命中的套路（可直接当 quote 定位）与改法；' +
      '传 text 则检查一段尚未提交的文字（提建议前自检）',
    write: false,
    params: obj({
      section: { type: 'string', description: '只查这一节（标题或标题 id，含子节）' },
      blocks: { type: 'array', items: { type: 'string' }, description: '只查这几段（段落 id）' },
      text: { type: 'string', description: '检查这段文字（不看文稿正文）' },
      genre: { type: 'string', enum: ['fiction', 'essay', 'general'], description: '文体；默认取文稿设置或自动判断' },
      baseline: { type: 'string', description: '按这份个人基线计算（"内置" 为内置人类基线）；默认按文稿的选择 / 默认基线' },
      limit: { type: 'integer', minimum: 1, maximum: 300, description: '最多列出多少处命中，默认 60' },
    }),
    run: (d, p, ctx) => {
      const genre = p.genre as 'fiction' | 'essay' | 'general' | undefined
      let baseline = ctx.baseline
      if (typeof p.baseline === 'string') {
        baseline = p.baseline === BUILTIN ? null : (getBaselineStore().baselines.find((b) => b.name === p.baseline) ?? null)
        if (p.baseline !== BUILTIN && !baseline) {
          const names = getBaselineStore().baselines.map((b) => b.name)
          throw new AgentError('NOT_FOUND', `没有基线「${p.baseline}」`, names.length ? `可用：${names.join('、')}、内置` : '还没有建立个人基线：suixin baseline build <名字> <作者原文…>')
        }
      }
      if (typeof p.text === 'string') return textView(d, p.text, genre, baseline)
      const scoped = genre ? { ...d, meta: { ...d.meta, flavor: { ...d.meta.flavor, genre } } } : d
      const section = p.section ? resolveHeading(d, p.section as string).id : undefined
      const report = analyzeProject(scoped, { section, blockIds: p.blocks as string[] | undefined }, baseline)
      return flavorView(d, report, (p.limit as number | undefined) ?? 60)
    },
  },
  {
    name: 'suggestions',
    summary: '列出建议（默认只看待处理的），含署名、理由、原文、建议文本、是否过期',
    write: false,
    params: obj({
      state: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'all'] },
      author: { type: 'string', description: '只看某个 agent 提的' },
      changeset: { type: 'string' },
    }),
    run: (d, p) => {
      const state = (p.state as string | undefined) ?? 'pending'
      return {
        suggestions: d.suggestions
          .filter((s) => state === 'all' || s.state === state)
          .filter((s) => !p.author || s.author?.name === p.author)
          .filter((s) => !p.changeset || s.changeset === p.changeset)
          .map((s) => suggestionView(d, s)),
      }
    },
  },
]

/* ── 写：文字 ─────────────────────────────────────── */

/** 文字修改：propose 落为建议，direct 直接写入 */
function textEdit(
  d: ProjectData,
  ctx: AgentContext,
  spec: TargetSpec,
  text: string,
  why: string | undefined,
  op: string
) {
  const t = resolveTarget(d, spec)
  if (t.kind === 'section' && !t.blockIds.length) {
    throw new AgentError('INVALID_PARAMS', '这一节还没有正文', '往空章节里写内容用 insert，位置给 {"section": 标题}')
  }
  const target = { blockIds: t.blockIds, range: t.range ?? null }
  const original = targetText(d, target)
  if (original == null) throw new AgentError('NOT_FOUND', '目标位置无效')
  // 整段删除一个空段落：文字没变，但段落本身要去掉
  if (original === text && !(op === 'delete' && !t.range)) return { op, changed: false, note: '文字没有变化' }
  if (ctx.mode === 'propose') {
    const merged = mergeIntoEarlier(d, ctx, t.blockIds, t.range, text, why)
    if (merged) return { op, mode: 'proposed', suggestion: merged, merged: true }
  }
  const suggestionId = addSuggestion(d, {
    kind: 'ai_diff',
    target,
    instruction: why ?? null,
    original,
    proposed: text,
    author: { kind: 'agent', name: ctx.author },
    why,
    changeset: ctx.changeset,
  })
  if (ctx.mode === 'propose') {
    ctx.edits?.set(t.blockIds.join(','), {
      suggestionId,
      whole: !t.range,
      ranges: t.range ? [{ start: t.range[0], end: t.range[1], text }] : [],
    })
    return { op, mode: 'proposed', suggestion: suggestionId, target, before: original, after: text, flavor: flavorWarning(d, original, text) }
  }
  const ids = applySuggestion(d, suggestionId, text)
  if (!ids) throw new AgentError('STALE', '原文已变化')
  return { op, mode: 'applied', blocks: ids, before: original, after: text, flavor: flavorWarning(d, original, text) }
}

/**
 * 同一次调用里对同一段的多处段内修改：合成一条段落级建议。
 * 返回合并后的建议 id；没有可合并的返回 null；无法合并（重叠 / 整段已改）时报冲突。
 */
function mergeIntoEarlier(
  d: ProjectData,
  ctx: AgentContext,
  blockIds: string[],
  range: [number, number] | undefined,
  text: string,
  why: string | undefined
): string | null {
  if (!ctx.edits) return null
  const key = blockIds.join(',')
  for (const k of ctx.edits.keys()) {
    if (k !== key && k.split(',').some((id) => blockIds.includes(id))) {
      throw new AgentError('CONFLICT', '这次调用里已经改过其中的段落', '对同一段的修改请合并成一次 replace')
    }
  }
  const rec = ctx.edits.get(key)
  if (!rec) return null
  if (!range || rec.whole) {
    throw new AgentError(
      'CONFLICT',
      '这次调用里已经改过这一段',
      '把对同一段的修改合并成一次 replace，或只用引文分别修改互不重叠的片段'
    )
  }
  if (rec.ranges.some((r) => range[0] < r.end && r.start < range[1])) {
    throw new AgentError('CONFLICT', '与这次调用里的另一处修改重叠', '合并成一次修改')
  }
  rec.ranges.push({ start: range[0], end: range[1], text })
  const para = getBlock(d, blockIds[0])!.text
  let proposed = para
  for (const r of [...rec.ranges].sort((a, b) => b.start - a.start)) {
    proposed = proposed.slice(0, r.start) + r.text + proposed.slice(r.end)
  }
  const s = d.suggestions.find((x) => x.id === rec.suggestionId)!
  s.target = { blockIds: [blockIds[0]], range: null }
  s.original = para
  s.proposed = proposed
  s.candidates = [proposed]
  s.diff = computeDiff(para, proposed)
  if (why) s.why = s.why ? `${s.why}；${why}` : why
  s.instruction = s.why ?? null
  return s.id
}

const writeTextOps: OpSpec[] = [
  {
    name: 'replace',
    summary: '把定位到的文字（段内一段 / 一段 / 连续多段 / 一节正文）换成新文字；多段用空行分隔，单行 "## 标题" 会成为标题',
    write: true,
    params: obj({ target: TARGET_SCHEMA, text: { type: 'string' }, why: WHY }, ['target', 'text']),
    run: (d, p, ctx) => textEdit(d, ctx, p.target as TargetSpec, p.text as string, p.why as string | undefined, 'replace'),
  },
  {
    name: 'delete',
    summary: '删除定位到的文字或段落',
    write: true,
    params: obj({ target: TARGET_SCHEMA, why: WHY }, ['target']),
    run: (d, p, ctx) => textEdit(d, ctx, p.target as TargetSpec, '', p.why as string | undefined, 'delete'),
  },
  {
    name: 'insert',
    summary: '在某处之后插入新内容（可多段，可含 "## 小标题"）；after 可为 "start" / "end" / 定位（章节则插在该节末尾）',
    write: true,
    params: obj({ after: POSITION_SCHEMA, text: { type: 'string' }, why: WHY }, ['after', 'text']),
    run: (d, p, ctx) => {
      const text = (p.text as string).trim()
      if (!text) throw new AgentError('INVALID_PARAMS', 'text 不能为空')
      const after = resolvePosition(d, p.after as 'start' | 'end' | TargetSpec)
      const why = p.why as string | undefined
      if (ctx.mode === 'propose') {
        const id = addSuggestion(d, {
          kind: 'ai_diff',
          target: { blockIds: [], insertAfter: after },
          instruction: why ?? null,
          original: '',
          proposed: text,
          author: { kind: 'agent', name: ctx.author },
          why,
          changeset: ctx.changeset,
        })
        return { op: 'insert', mode: 'proposed', suggestion: id, after, flavor: flavorWarning(d, '', text) }
      }
      const fresh = textToBlocks(text, 'agent', why ?? null, ctx.author)
      const at = after ? indexOfBlock(d, after) + 1 : 0
      d.blocks.splice(at, 0, ...fresh)
      return { op: 'insert', mode: 'applied', blocks: fresh.map((b) => b.id), flavor: flavorWarning(d, '', text) }
    },
  },
  {
    name: 'note',
    summary: '只提意见不改文字：在某段旁留下"问题 + 建议"，作者可一键让 AI 按建议修改',
    write: true,
    params: obj(
      {
        target: TARGET_SCHEMA,
        issue: { type: 'string', description: '发现的问题' },
        advice: { type: 'string', description: '具体修改建议' },
      },
      ['target', 'issue', 'advice']
    ),
    run: (d, p, ctx) => {
      const t = resolveTarget(d, p.target as TargetSpec)
      const block = t.blockIds[0] ?? t.headingId
      if (!block) throw new AgentError('INVALID_PARAMS', '找不到可以挂建议的段落')
      const id = addSuggestion(d, {
        kind: 'note',
        target: { blockIds: [block] },
        instruction: p.advice as string,
        issue: p.issue as string,
        original: getBlock(d, block)?.text ?? '',
        proposed: '',
        author: { kind: 'agent', name: ctx.author },
        changeset: ctx.changeset,
      })
      return { op: 'note', suggestion: id, block }
    },
  },
  {
    name: 'withdraw',
    summary: '撤回自己提出、作者还没处理的建议',
    write: true,
    params: obj({ suggestion: { type: 'string' } }, ['suggestion']),
    run: (d, p, ctx) => {
      const s = d.suggestions.find((x) => x.id === p.suggestion)
      if (!s) throw new AgentError('NOT_FOUND', `找不到建议 ${p.suggestion}`)
      if (s.author?.name !== ctx.author) {
        throw new AgentError('NOT_AUTHORIZED', '只能撤回自己提出的建议')
      }
      if (!dismissSuggestion(d, s.id)) throw new AgentError('INVALID_PARAMS', '这条建议已经处理过了')
      return { op: 'withdraw', suggestion: s.id }
    },
  },
]

/* ── 写：结构与元信息（仅直接修改） ────────────────── */

const structureOps: OpSpec[] = [
  {
    name: 'rename_heading',
    summary: '改标题文字',
    write: true,
    directOnly: true,
    params: obj({ heading: { type: 'string', description: '标题或其 id' }, text: { type: 'string' } }, ['heading', 'text']),
    run: (d, p, ctx) => {
      const h = resolveHeading(d, p.heading as string)
      editBlock(d, h.id, p.text as string, 'agent', null, ctx.author)
      return { op: 'rename_heading', heading: h.id }
    },
  },
  {
    name: 'add_heading',
    summary: '插入一个标题',
    write: true,
    directOnly: true,
    params: obj(
      { after: POSITION_SCHEMA, level: { type: 'integer', minimum: 1, maximum: 6 }, text: { type: 'string' } },
      ['after', 'level', 'text']
    ),
    run: (d, p) => {
      const after = resolvePosition(d, p.after as 'start' | 'end' | TargetSpec)
      const id = insertHeadingAfter(d, after, p.level as number, p.text as string)
      return { op: 'add_heading', heading: id }
    },
  },
  {
    name: 'move_section',
    summary: '移动整节（含子节与正文）到另一节的前 / 后 / 内部末尾，层级自动调整',
    write: true,
    directOnly: true,
    params: obj(
      {
        heading: { type: 'string', description: '要移动的节（标题或 id）' },
        to: { type: 'string', description: '参照节（标题或 id）' },
        position: { type: 'string', enum: ['before', 'after', 'inside'] },
      },
      ['heading', 'to', 'position']
    ),
    run: (d, p) => {
      const h = resolveHeading(d, p.heading as string)
      const to = resolveHeading(d, p.to as string)
      if (!moveSection(d, h.id, to.id, p.position as 'before' | 'after' | 'inside')) {
        throw new AgentError('INVALID_PARAMS', '无法这样移动（不能移进自己的子节，层级也不能超过六级）')
      }
      return { op: 'move_section', heading: h.id }
    },
  },
  {
    name: 'set_level',
    summary: '整节升级（delta=-1）或降级（delta=1）',
    write: true,
    directOnly: true,
    params: obj({ heading: { type: 'string' }, delta: { type: 'integer', enum: [-1, 1] } }, ['heading', 'delta']),
    run: (d, p) => {
      const h = resolveHeading(d, p.heading as string)
      if (!shiftSectionLevel(d, h.id, p.delta as number)) throw new AgentError('INVALID_PARAMS', '层级已到边界（1–6）')
      return { op: 'set_level', heading: h.id }
    },
  },
  {
    name: 'remove_heading',
    summary: '删除标题（正文保留，并入上一节）',
    write: true,
    directOnly: true,
    params: obj({ heading: { type: 'string' } }, ['heading']),
    run: (d, p) => {
      const h = resolveHeading(d, p.heading as string)
      removeBlock(d, h.id)
      return { op: 'remove_heading', heading: h.id }
    },
  },
  {
    name: 'set_title',
    summary: '改文稿标题',
    write: true,
    directOnly: true,
    params: obj({ title: { type: 'string' } }, ['title']),
    run: (d, p) => {
      d.meta.title = (p.title as string).trim()
      d.meta.titleAsHeading = true
      return { op: 'set_title' }
    },
  },
  {
    name: 'set_brief',
    summary: '改写作设定（读者、语气、禁用词等）',
    write: true,
    directOnly: true,
    params: obj({ brief: { type: 'string' } }, ['brief']),
    run: (d, p) => {
      d.brief = (p.brief as string).trim()
      return { op: 'set_brief' }
    },
  },
  {
    name: 'resolve',
    summary: '替作者接受或放弃一条待处理的修改建议',
    write: true,
    directOnly: true,
    params: obj(
      { suggestion: { type: 'string' }, decision: { type: 'string', enum: ['accept', 'reject'] } },
      ['suggestion', 'decision']
    ),
    run: (d, p) => {
      const s = d.suggestions.find((x) => x.id === p.suggestion)
      if (!s || s.state !== 'pending') throw new AgentError('NOT_FOUND', `没有待处理的建议 ${p.suggestion}`)
      if (p.decision === 'reject' || s.kind === 'note') {
        dismissSuggestion(d, s.id)
        return { op: 'resolve', suggestion: s.id, decision: 'reject' }
      }
      const ids = applySuggestion(d, s.id, s.proposed)
      if (!ids) throw new AgentError('STALE', '原文已变化，这条建议已过期')
      return { op: 'resolve', suggestion: s.id, decision: 'accept', blocks: ids }
    },
  },
]

/* ── 交给 Agent 的任务 ─────────────────────────────── */

function taskView(d: ProjectData, t: AgentTask) {
  const now = t.target.blockIds.length ? targetText(d, t.target) : null
  return {
    id: t.id,
    state: t.state,
    instruction: t.instruction,
    target: t.target,
    section: t.section,
    quote: t.quote,
    // 交办后那处原文被改过：先 read 看看现在的样子再动手
    changed: now !== null && now !== t.quote ? true : undefined,
    claimedBy: t.claimedBy,
    summary: t.summary,
    createdAt: t.createdAt,
  }
}

function taskError(r: Exclude<ClaimResult, { ok: true }>, id: string): AgentError {
  if (r.reason === 'not_found') return new AgentError('NOT_FOUND', `没有任务 ${id}`, '用 tasks 查看现有任务')
  if (r.reason === 'taken') return new AgentError('CONFLICT', `任务已由 ${r.task?.claimedBy} 接手`, '换一个任务')
  return new AgentError('INVALID_PARAMS', `任务已${r.task?.state === 'done' ? '完成' : '被作者取消'}`)
}

const taskOps: OpSpec[] = [
  {
    name: 'tasks',
    summary: '作者"交给 Agent"的任务：要求、作用位置与原文；默认只列还没做完的',
    write: false,
    params: obj({ state: { type: 'string', enum: ['active', 'open', 'claimed', 'done', 'cancelled', 'all'] } }),
    run: (d, p) => {
      const state = (p.state as string | undefined) ?? 'active'
      const list = tasksOf(d).filter((t) => (state === 'all' ? true : state === 'active' ? isActive(t) : t.state === state))
      return { tasks: list.map((t) => taskView(d, t)) }
    },
  },
  {
    name: 'claim_task',
    summary: '接手一个任务（作者会看到你在处理）；之后照常提建议，做完用 complete_task',
    write: true,
    params: obj({ task: { type: 'string', description: '任务 id' } }, ['task']),
    run: (d, p, ctx) => {
      const r = claimTask(d, p.task as string, ctx.author)
      if (!r.ok) throw taskError(r, p.task as string)
      return { op: 'claim_task', task: taskView(d, r.task) }
    },
  },
  {
    name: 'complete_task',
    summary: '标记任务完成，并用一句话告诉作者你做了什么',
    write: true,
    params: obj({ task: { type: 'string' }, summary: { type: 'string', description: '给作者的说明，如"提了 3 处修改，见待办"' } }, ['task']),
    run: (d, p, ctx) => {
      const r = completeTask(d, p.task as string, ctx.author, p.summary as string | undefined)
      if (!r.ok) throw taskError(r, p.task as string)
      return { op: 'complete_task', task: taskView(d, r.task) }
    },
  },
]

export const OPS: OpSpec[] = [...readOps, ...writeTextOps, ...structureOps, ...taskOps]

export function getOp(name: string): OpSpec {
  const op = OPS.find((o) => o.name === name)
  if (!op) {
    throw new AgentError('UNKNOWN_OP', `没有操作 ${name}`, `可用：${OPS.map((o) => o.name).join(', ')}`)
  }
  return op
}

/** 供 `suixin ops` / MCP 使用的公开描述 */
export function describeOps() {
  return OPS.map((o) => ({
    name: o.name,
    summary: o.summary,
    write: o.write,
    ...(o.directOnly ? { directOnly: true } : {}),
    params: o.params,
  }))
}

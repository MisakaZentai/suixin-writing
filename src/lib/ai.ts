/**
 * OpenAI 兼容端点客户端（spec §7：直连服务商 + SSE 流式，无需后端；桌面版请求经 Rust 侧发出，见 platform.httpFetch）。
 * 重写/意见修改均要求模型只输出改后文本，diff 在前端计算（spec §7 Prompt 要点）。
 */
import type { HeadingBlock, ProjectData, SuggestionTarget } from '../types'
import { headingPaths, outlineSummary, targetText } from './doc'
import { httpFetch } from './platform'

export interface AIConfig {
  baseURL: string
  apiKey: string
  model: string
  temperature: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function endpoint(baseURL: string): string {
  return baseURL.replace(/\/+$/, '') + '/chat/completions'
}

/**
 * 被中断时统一抛出标准的 AbortError：桌面版的请求走 Rust 侧，
 * 中断时抛的是 "Request cancelled"，调用方只认 AbortError。
 */
function abortedError(signal?: AbortSignal): DOMException | null {
  return signal?.aborted ? new DOMException('已中断', 'AbortError') : null
}

/** 桌面版的请求走 Rust 侧，失败时抛的可能是字符串而不是 Error */
function reason(e: unknown): string {
  return (e instanceof Error ? e.message : typeof e === 'string' ? e : '') || '网络错误'
}

/** 抛错前尽量读出服务端错误信息 */
async function errorBody(res: Response): Promise<string> {
  try {
    const t = await res.text()
    return t.slice(0, 300)
  } catch {
    return ''
  }
}

/** 流式对话：yield 增量文本 */
export async function* chatStream(
  config: AIConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  if (!config.apiKey) throw new Error('尚未配置 API Key，请前往「设置」')
  let res: Response
  try {
    res = await httpFetch(endpoint(config.baseURL), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        stream: true,
      }),
      signal,
    })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    throw abortedError(signal) ?? new Error(
      `无法连接 ${config.baseURL}（${reason(e)}）`
    )
  }
  if (!res.ok || !res.body) {
    throw new Error(`API 返回 ${res.status}：${await errorBody(res)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch (e) {
      throw abortedError(signal) ?? e
    }
    const { done, value } = chunk
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const json = JSON.parse(payload)
        const delta: string = json.choices?.[0]?.delta?.content ?? ''
        if (delta) yield delta
      } catch {
        /* 跳过不完整行 */
      }
    }
  }
}

/** 一次性对话（大纲反推 / 对齐检查等 JSON 输出场景） */
export async function chatOnce(
  config: AIConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<string> {
  if (!config.apiKey) throw new Error('尚未配置 API Key，请前往「设置」')
  let res: Response
  try {
    res = await httpFetch(endpoint(config.baseURL), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        stream: false,
      }),
      signal,
    })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    throw abortedError(signal) ?? new Error(
      `无法连接 ${config.baseURL}（${reason(e)}）`
    )
  }
  if (!res.ok) throw new Error(`API 返回 ${res.status}：${await errorBody(res)}`)
  const json = await res.json()
  return (json.choices?.[0]?.message?.content ?? '') as string
}

/** 从模型输出中稳健提取 JSON（容忍 ```json 围栏与首尾杂音） */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[[{]/)
  const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'))
  if (start < 0 || end <= start) throw new Error('AI 未返回有效的 JSON')
  return JSON.parse(body.slice(start, end + 1)) as T
}

/* ── Prompt 组装 ─────────────────────────────────────── */

const RULES = `要求：
1. 只输出修改后的正文文本本身；
2. 不要输出任何解释、前后缀、引号或 Markdown 代码块；
3. 保持原文事实、数据、人名不变，不新增原文没有的信息；
4. 语言与原文保持一致；
5. 有多个段落时，段落之间用一个空行分隔；
6. 单独一行、形如 ![图注](路径) 的是图片，原样保留在原来的位置；
7. 避免 AI 腔：旁白里不用"不是…而是…""不仅…更是…"这类先否定再纠正、递进拔高的句式，少用破折号，
   不用"值得注意的是""总而言之"一类过渡，不在段末升华总结，不堆砌"仿佛、微微、缓缓"之类虚词。`

const REWRITE_SYSTEM = `你是一位资深的中文写作编辑。用户会给你一段正文，请在保持原意的前提下重写它，使表达更准确、流畅、有节奏。${RULES}`

const REVISE_SYSTEM = `你是一位资深的中文写作编辑。用户会给你一段正文和一条修改意见，请严格按照意见修改。${RULES}`

/** 一次 AI 请求所需的上下文（spec §7：当前内容 + 标题路径 + 前后文 + 全文大纲） */
export interface AIContext {
  title: string
  outline: string
  path: string
  before: string
  target: string
  after: string
  brief?: string
  /** 待处理正文只是一段话中的一部分 */
  partial?: boolean
}

/** 根据建议目标组装上下文 */
export function buildAIContext(project: ProjectData, target: SuggestionTarget): AIContext {
  const blocks = project.blocks
  const paths = headingPaths(blocks)
  let firstIdx: number
  let lastIdx: number
  let pathIds: HeadingBlock[]
  if (target.blockIds.length) {
    firstIdx = blocks.findIndex((b) => b.id === target.blockIds[0])
    lastIdx = firstIdx + target.blockIds.length - 1
    pathIds = paths.get(target.blockIds[0]) ?? []
  } else {
    const anchor = target.insertAfter ? blocks.findIndex((b) => b.id === target.insertAfter) : -1
    firstIdx = anchor + 1
    lastIdx = anchor
    const anchorBlock = blocks[anchor]
    pathIds = anchorBlock
      ? anchorBlock.type === 'heading'
        ? [...(paths.get(anchorBlock.id) ?? []), anchorBlock]
        : paths.get(anchorBlock.id) ?? []
      : []
  }
  /** 插入型（续写）需要更多前文：往前最多取 n 段，遇到标题为止 */
  const precedingText = (from: number, n: number): string => {
    const parts: string[] = []
    for (let i = from; i >= 0 && parts.length < n; i--) {
      const b = blocks[i]
      if (b.type === 'heading') break
      if (b.text.trim()) parts.unshift(b.text)
    }
    return parts.join('\n\n')
  }
  const paragraphText = (from: number, step: 1 | -1): string => {
    for (let i = from; i >= 0 && i < blocks.length; i += step) {
      const b = blocks[i]
      if (b.type === 'paragraph' && b.text.trim()) return b.text
    }
    return ''
  }
  let before = target.blockIds.length ? paragraphText(firstIdx - 1, -1) : precedingText(firstIdx - 1, 3)
  let after = paragraphText(lastIdx + 1, 1)
  if (target.range && target.blockIds.length === 1) {
    const text = blocks[firstIdx]?.text ?? ''
    before = text.slice(0, target.range[0]) || before
    after = text.slice(target.range[1]) || after
  }
  return {
    title: project.meta.title,
    outline: outlineSummary(blocks),
    path: pathIds.map((h) => h.text).join(' / '),
    before,
    target: targetText(project, target) ?? '',
    after,
    brief: project.brief?.trim() || undefined,
    partial: Boolean(target.range),
  }
}

export function buildContextMessage(ctx: AIContext): string {
  return [
    `【文档标题】${ctx.title}`,
    ctx.brief ? `【写作设定】${ctx.brief}` : '',
    `【全文大纲】${ctx.outline || '（无大纲）'}`,
    `【本节路径】${ctx.path || '（不在任何章节下）'}`,
    `【前文】${ctx.before || '（无）'}`,
    ctx.partial ? '【待处理正文】（这是一段话中间的一部分，改完要能与前后文自然衔接，只输出这一部分）' : '【待处理正文】',
    ctx.target,
    `【后文】${ctx.after || '（无）'}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function summarizeOutline(project: ProjectData): string {
  return outlineSummary(project.blocks)
}

/* ── AI 任务 ─────────────────────────────────────────── */

export function rewriteMessages(ctx: AIContext): ChatMessage[] {
  return [
    { role: 'system', content: REWRITE_SYSTEM },
    { role: 'user', content: buildContextMessage(ctx) },
  ]
}

export function reviseMessages(ctx: AIContext, instruction: string): ChatMessage[] {
  return [
    { role: 'system', content: REVISE_SYSTEM },
    { role: 'user', content: buildContextMessage(ctx) + `\n【修改意见】${instruction}` },
  ]
}

/** 去 AI 味：交给模型的一处命中 */
export interface FlavorTarget {
  quote: string
  name: string
  advice: string
}

export type DeflavorMode = 'words' | 'sentences' | 'paragraph'

const DEFLAVOR_SCOPE: Record<DeflavorMode, string> = {
  words: '只替换命中的词句本身，其余一个字都不要动',
  sentences: '只改命中所在的句子，没有命中的句子原样保留',
  paragraph: '可以调整这一段的句子结构与顺序，但意思、信息与篇幅不变',
}

const DEFLAVOR_SYSTEM = `你是一位资深的中文编辑，专门去掉文字里的"AI 腔"。用户会给你一段正文和其中被标出的 AI 腔（位置、类型与改法），请逐处改掉。
铁律：
1. 功能守恒：信息不增不减，不新增事实、数字、人名、引文，不改变肯定与否定的强弱；
2. 优先替换，不要删除——删成干巴巴的大白话是最差的改法；情绪落点句只换说法，不删；
3. 不要用一种套路替换另一种：不许新增破折号、三连排比、"不是…而是…"、升华收尾、"值得注意的是"之类；
4. 把抽象的换成具体的动作、细节或感官；比喻要落在具体的形状、动作或触感上；
5. 对白里的口吻、人物的口头禅与省略号保留；
6. 篇幅变化不超过三成；语言、人称、时态与原文一致；
7. 只输出修改后的正文，不要解释、引号或 Markdown 代码块；有多个段落时段落之间空一行；单独一行的 ![图注](路径) 原样保留。`

/** 去 AI 味：带着命中清单与作者示范段落的定向改写 */
export function deflavorMessages(
  ctx: AIContext,
  targets: FlavorTarget[],
  opts: { mode?: DeflavorMode; samples?: string[] } = {}
): ChatMessage[] {
  const list = targets.map((t, i) => `${i + 1}. 「${t.quote}」——${t.name}。改法：${t.advice}`).join('\n')
  const samples = opts.samples?.filter(Boolean) ?? []
  const user = [
    buildContextMessage(ctx),
    `【要处理的 AI 腔】`,
    list || '（没有具体命中：整体检查一遍，按铁律去掉 AI 腔）',
    `【改动范围】${DEFLAVOR_SCOPE[opts.mode ?? 'sentences']}`,
    samples.length ? `【作者自己写的段落（体会语感，不要照抄内容）】\n${samples.join('\n\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return [
    { role: 'system', content: DEFLAVOR_SYSTEM },
    { role: 'user', content: user },
  ]
}

/** 复检没通过：把这一版和剩下的问题交回去，在这一版上接着改 */
export function deflavorRetryMessages(messages: ChatMessage[], previous: string, problems: string[]): ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: previous },
    {
      role: 'user',
      content: `这一版还有问题：\n${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n请在这一版的基础上只改这些地方，只输出修改后的正文。`,
    },
  ]
}

/** 续写：接着前文往下写新段落 */
export function continueMessages(ctx: AIContext, instruction: string | null): ChatMessage[] {
  const user = [
    `【文档标题】${ctx.title}`,
    ctx.brief ? `【写作设定】${ctx.brief}` : '',
    `【全文大纲】${ctx.outline || '（无大纲）'}`,
    `【本节路径】${ctx.path || '（不在任何章节下）'}`,
    `【前文】`,
    ctx.before || '（文首，暂无前文）',
    `【后文】${ctx.after || '（无）'}`,
    instruction ? `【续写要求】${instruction}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return [
    {
      role: 'system',
      content:
        '你是一位资深的中文写作编辑。请接着【前文】往下写一到两段，风格、人称、语气与前文保持一致，并与【后文】自然衔接。' +
        '只输出新写的正文，不要重复前文，不要输出解释、引号或 Markdown 代码块；多段之间用一个空行分隔。',
    },
    { role: 'user', content: user },
  ]
}

/** 章节扩写：基于章节标题与已有内容，写出完整的章节正文 */
export function expandMessages(ctx: AIContext, sectionTitle: string): ChatMessage[] {
  const user = [
    `【文档标题】${ctx.title}`,
    ctx.brief ? `【写作设定】${ctx.brief}` : '',
    `【全文大纲】${ctx.outline || '（无大纲）'}`,
    `【待扩写章节】${ctx.path || sectionTitle}`,
    `【该节已有内容】`,
    ctx.target || '（该节当前为空）',
    `【前文】${ctx.before || '（无）'}`,
    `【后文】${ctx.after || '（无）'}`,
  ]
    .filter(Boolean)
    .join('\n')
  return [
    {
      role: 'system',
      content: `你是一位资深的中文写作编辑。用户希望你把大纲中的某一章节写成完整的正文：已有内容要保留其要点并充实，空章节则按标题与全文大纲新写。输出这一节完整的正文段落（不含标题）。${RULES.replace('3. 保持原文事实、数据、人名不变，不新增原文没有的信息；', '3. 保持已有内容中的事实、数据、人名不变；')}`,
    },
    { role: 'user', content: user },
  ]
}

export interface AlignmentIssue {
  index: number
  issue: string
  advice: string
}

/** 章节检查：找出偏离标题意图、顺序不当或重复累赘的段落，产出建议而非改动 */
export async function checkAlignment(
  config: AIConfig,
  project: ProjectData,
  sectionTitle: string,
  paragraphs: string[]
): Promise<AlignmentIssue[]> {
  const numbered = paragraphs.map((t, i) => `[${i + 1}] ${t}`).join('\n\n')
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是文章结构审校编辑。用户给你一节正文与其标题，请找出偏离标题意图、顺序不当或重复累赘的段落。' +
        '只输出 JSON：{"issues":[{"index":段落编号,"issue":"问题描述","advice":"具体修改建议"}]}，无问题时输出 {"issues":[]}。',
    },
    {
      role: 'user',
      content: `【全文大纲】${summarizeOutline(project)}\n【本章标题】${sectionTitle}\n【本章段落】\n${numbered}`,
    },
  ]
  const text = await chatOnce(config, messages)
  const parsed = extractJson<{ issues: AlignmentIssue[] }>(text)
  const issues = Array.isArray(parsed.issues) ? parsed.issues : []
  return issues.filter((i) => typeof i.index === 'number' && i.issue && i.advice)
}

/** 全文检查：通读全文，找出有问题的段落，只给建议 */
export async function reviewDocument(
  config: AIConfig,
  project: ProjectData
): Promise<{ issues: AlignmentIssue[]; paragraphIds: string[] }> {
  const paths = headingPaths(project.blocks)
  const lines: string[] = []
  const paragraphIds: string[] = []
  let budget = 14000
  for (const b of project.blocks) {
    if (b.type !== 'paragraph' || !b.text.trim()) continue
    if (budget <= 0) break
    const section = (paths.get(b.id) ?? []).slice(-1)[0]?.text
    const text = b.text.slice(0, 600)
    paragraphIds.push(b.id)
    lines.push(`[${paragraphIds.length}]${section ? `（${section}）` : ''} ${text}`)
    budget -= text.length
  }
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是资深审稿编辑。通读全文，找出偏离章节主题、前后矛盾、重复累赘、逻辑跳跃或表达明显有问题的段落。' +
        '只输出 JSON：{"issues":[{"index":段落编号,"issue":"问题","advice":"具体修改建议"}]}，最多 12 条，没有问题输出 {"issues":[]}。',
    },
    {
      role: 'user',
      content: `【文档标题】${project.meta.title}\n${project.brief ? `【写作设定】${project.brief}\n` : ''}【全文大纲】${summarizeOutline(project) || '（无大纲）'}\n【正文段落】\n${lines.join('\n\n')}`,
    },
  ]
  const text = await chatOnce(config, messages)
  const parsed = extractJson<{ issues: AlignmentIssue[] }>(text)
  const issues = (Array.isArray(parsed.issues) ? parsed.issues : []).filter(
    (i) => typeof i.index === 'number' && i.issue && i.advice
  )
  return { issues, paragraphIds }
}

export interface InferredHeading {
  /** 标题插在第几段之前（从 1 开始） */
  before: number
  level: number
  title: string
}

/** AI 反推大纲：返回应插入的标题及其位置 */
export async function inferOutline(
  config: AIConfig,
  paragraphs: string[]
): Promise<{ title: string; headings: InferredHeading[] }> {
  let budget = 12000
  const numbered: string[] = []
  for (let i = 0; i < paragraphs.length && budget > 0; i++) {
    const t = paragraphs[i].slice(0, 400)
    numbered.push(`[${i + 1}] ${t}`)
    budget -= t.length
  }
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是文章结构分析师。用户给出按编号排列的段落，请为文章划分章节：给出每个章节标题应插在第几段之前，层级 2 为章，3 为节，最多到 4。' +
        '只输出 JSON：{"title":"文档标题","headings":[{"before":段落编号,"level":2,"title":"章节标题"}]}，before 按升序排列。',
    },
    { role: 'user', content: numbered.join('\n') },
  ]
  const text = await chatOnce(config, messages)
  const parsed = extractJson<{ title?: string; headings?: InferredHeading[] }>(text)
  const headings = (Array.isArray(parsed.headings) ? parsed.headings : []).filter(
    (h) =>
      typeof h.before === 'number' &&
      h.before >= 1 &&
      h.before <= paragraphs.length &&
      typeof h.title === 'string' &&
      h.title.trim()
  )
  return { title: String(parsed.title ?? ''), headings }
}

/** 测试连接：最小请求验证 Key 与端点 */
export async function testConnection(config: AIConfig): Promise<void> {
  await chatOnce(
    { ...config, temperature: 0 },
    [{ role: 'user', content: 'ping' }]
  )
}

/**
 * OpenAI 兼容端点客户端（spec §7：fetch 直连 + SSE 流式，无需后端）。
 * 重写/意见修改均要求模型只输出改后文本，diff 在前端计算（spec §7 Prompt 要点）。
 */
import type { DisplayBlock, OutlineNode, ProjectData } from '../types'

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
    res = await fetch(endpoint(config.baseURL), {
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
    throw new Error(
      `无法连接 ${config.baseURL}（${(e as Error).message || '网络错误'}）`
    )
  }
  if (!res.ok || !res.body) {
    throw new Error(`API 返回 ${res.status}：${await errorBody(res)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
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
    res = await fetch(endpoint(config.baseURL), {
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
    throw new Error(
      `无法连接 ${config.baseURL}（${(e as Error).message || '网络错误'}）`
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
4. 语言与原文保持一致。`

const REWRITE_SYSTEM = `你是一位资深的中文写作编辑。用户会给你一段正文，请在保持原意的前提下重写它，使表达更准确、流畅、有节奏。${RULES}`

const REVISE_SYSTEM = `你是一位资深的中文写作编辑。用户会给你一段正文和一条修改意见，请严格按照意见修改。${RULES}`

/** 上下文 = 当前块 + 大纲节点路径 + 相邻前后块 + 全文大纲摘要（spec §7） */
export function buildContextMessage(
  project: ProjectData,
  block: DisplayBlock,
  allBlocks: DisplayBlock[]
): string {
  const path =
    block.outlinePath.length > 0
      ? block.outlinePath.map((n) => n.title).join(' / ')
      : '（未挂靠大纲）'
  const idx = allBlocks.findIndex((b) => b.key === block.key)
  const prev = idx > 0 ? allBlocks[idx - 1].text : '（无）'
  const next =
    idx >= 0 && idx < allBlocks.length - 1 ? allBlocks[idx + 1].text : '（无）'
  const outlineSummary = summarizeOutline(project.outline) || '（无大纲）'
  return [
    `【文档标题】${project.meta.title}`,
    `【全文大纲】${outlineSummary}`,
    `【本节大纲路径】${path}`,
    `【前文】${prev}`,
    `【待处理正文】`,
    block.text,
    `【后文】${next}`,
  ].join('\n')
}

export function summarizeOutline(nodes: OutlineNode[]): string {
  const walk = (list: OutlineNode[], depth: number): string[] =>
    list.flatMap((n) => [
      `${'  '.repeat(depth)}- ${n.title}`,
      ...walk(n.children, depth + 1),
    ])
  return walk(nodes, 0).join('\n')
}

/* ── 三种 AI 任务 ────────────────────────────────────── */

export function rewriteMessages(
  project: ProjectData,
  block: DisplayBlock,
  allBlocks: DisplayBlock[]
): ChatMessage[] {
  return [
    { role: 'system', content: REWRITE_SYSTEM },
    { role: 'user', content: buildContextMessage(project, block, allBlocks) },
  ]
}

export function reviseMessages(
  project: ProjectData,
  block: DisplayBlock,
  allBlocks: DisplayBlock[],
  instruction: string
): ChatMessage[] {
  return [
    { role: 'system', content: REVISE_SYSTEM },
    {
      role: 'user',
      content:
        buildContextMessage(project, block, allBlocks) +
        `\n【修改意见】${instruction}`,
    },
  ]
}

/** 大纲节点扩写：基于节点意图把内容补写成正文 */
export function expandMessages(
  project: ProjectData,
  node: OutlineNode,
  nodeBlocks: DisplayBlock[],
  allBlocks: DisplayBlock[]
): ChatMessage[] {
  const existing = nodeBlocks.map((b) => b.text).join('\n') || '（该节当前为空）'
  const user = [
    `【文档标题】${project.meta.title}`,
    `【全文大纲】${summarizeOutline(project.outline)}`,
    `【待扩写章节】${node.title}`,
    `【该节已有内容】`,
    existing,
    `【前文】${
      allBlocks.length && nodeBlocks.length
        ? allBlocks[Math.max(0, allBlocks.findIndex((b) => b.blockIds[0] === nodeBlocks[0].blockIds[0]) - 1)]
            ?.text ?? '（无）'
        : '（无）'
    }`,
  ].join('\n')
  return [
    {
      role: 'system',
      content: `你是一位资深的中文写作编辑。用户希望你为大纲中的某一章节续写正文。请紧扣章节主题与全文大纲，写出连贯、有细节的正文段落。${RULES}`,
    },
    { role: 'user', content: user },
  ]
}

export interface AlignmentIssue {
  index: number
  issue: string
  advice: string
}

/** 大纲对齐检查：产出建议而非直接改动（spec F5） */
export async function checkAlignment(
  config: AIConfig,
  project: ProjectData,
  node: OutlineNode,
  nodeBlocks: DisplayBlock[]
): Promise<AlignmentIssue[]> {
  const numbered = nodeBlocks
    .map((b, i) => `[${i + 1}] ${b.text}`)
    .join('\n\n')
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是文章结构审校编辑。用户给你一节正文与其大纲标题，请找出偏离大纲意图、顺序不当或重复累赘的段落。' +
        '只输出 JSON：{"issues":[{"index":段落编号,"issue":"问题描述","advice":"具体修改建议"}]}，无问题时输出 {"issues":[]}。',
    },
    {
      role: 'user',
      content: `【全文大纲】${summarizeOutline(project.outline)}\n【本章标题】${node.title}\n【本章段落】\n${numbered}`,
    },
  ]
  const text = await chatOnce(config, messages)
  const parsed = extractJson<{ issues: AlignmentIssue[] }>(text)
  const issues = Array.isArray(parsed.issues) ? parsed.issues : []
  return issues.filter(
    (i) => typeof i.index === 'number' && i.issue && i.advice
  )
}

export interface InferredOutline {
  title: string
  outline: { title: string; children?: InferredOutline['outline'] }[]
}

/** AI 反推大纲（spec F1 / M3） */
export async function inferOutline(
  config: AIConfig,
  project: ProjectData
): Promise<InferredOutline> {
  const excerpt = project.blocks
    .map((b) => b.text)
    .join('\n')
    .slice(0, 6000)
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是文章结构分析师。阅读用户正文，提炼出清晰的三级以内大纲。' +
        '只输出 JSON：{"title":"文档标题","outline":[{"title":"一级标题","children":[{"title":"二级标题"}]}]}。',
    },
    {
      role: 'user',
      content: `【文档标题】${project.meta.title}\n【正文摘录】\n${excerpt}`,
    },
  ]
  const text = await chatOnce(config, messages)
  return extractJson<InferredOutline>(text)
}

/** 测试连接：最小请求验证 Key 与端点 */
export async function testConnection(config: AIConfig): Promise<void> {
  await chatOnce(
    { ...config, temperature: 0 },
    [{ role: 'user', content: 'ping' }]
  )
}

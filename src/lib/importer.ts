/**
 * 导入解析（spec F1）：
 * - Markdown：# 标题 → 大纲节点；段落 → 块
 * - txt：按空行分段，无大纲
 * - 无段落结构时按句子兜底
 * - >20 万字截断并提示（spec §9）
 */
import type { Block, OutlineNode, Version } from '../types'
import { splitParagraphs, splitSentences } from './segmenter'
import { uid, nowISO } from './ids'

export const MAX_DOC_CHARS = 200_000

export interface ParseResult {
  title: string
  outline: OutlineNode[]
  blocks: Block[]
  truncated: boolean
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/

function makeVersion(text: string): Version {
  return { v: 0, text, source: 'import', instruction: null, at: nowISO() }
}

function makeBlocks(
  sentences: string[],
  paragraphId: string,
  outlineNodeId: string | null,
  startOrder: number
): Block[] {
  const at = nowISO()
  const versions = sentences.map((s) => ({
    v: 0,
    text: s,
    source: 'import' as const,
    instruction: null,
    at,
  }))
  return sentences.map((text, i) => ({
    id: uid('b'),
    outlineNodeId,
    order: startOrder + i,
    text,
    status: 'clean' as const,
    versions: [versions[i]],
    paragraphId,
  }))
}

/** 找最近一个层级小于 level 的祖先，挂为父节点 */
function attachNode(
  roots: OutlineNode[],
  stack: OutlineNode[],
  level: number,
  node: OutlineNode
): void {
  // 标题层级跳跃（如 # 直接到 ###）时按栈深度归拢
  while (stack.length >= level) stack.pop()
  const parent = stack[stack.length - 1]
  if (parent) parent.children.push(node)
  else roots.push(node)
  stack.push(node)
}

export function parseDocument(raw: string): ParseResult {
  let text = raw.replace(/\r\n?/g, '\n')
  let truncated = false
  if (text.length > MAX_DOC_CHARS) {
    text = text.slice(0, MAX_DOC_CHARS)
    truncated = true
  }

  const lines = text.split('\n')
  const outline: OutlineNode[] = []
  const stack: OutlineNode[] = []
  const blocks: Block[] = []
  let currentNode: OutlineNode | null = null
  let pending: string[] = []
  let title = ''
  let isFirstHeading = true

  const flush = () => {
    const paragraph = pending.join('\n').trim()
    pending = []
    if (!paragraph) return
    const sentences = splitSentences(paragraph)
    const pid = uid('p')
    const created = makeBlocks(
      sentences,
      pid,
      currentNode ? currentNode.id : null,
      blocks.length
    )
    blocks.push(...created)
  }

  for (const line of lines) {
    const m = HEADING_RE.exec(line)
    if (m) {
      flush()
      const level = m[1].length
      const heading = m[2].trim()
      if (isFirstHeading && level === 1 && !title) {
        // 文档主标题：进 meta，不进大纲
        title = heading
        isFirstHeading = false
        continue
      }
      isFirstHeading = false
      const node: OutlineNode = { id: uid('on'), title: heading, children: [] }
      attachNode(outline, stack, level, node)
      currentNode = node
      continue
    }
    pending.push(line)
  }
  flush()

  if (!blocks.length) {
    // 空文档兜底：不给任何块
  }

  return {
    title: title || '未命名文稿',
    outline,
    blocks,
    truncated,
  }
}

/** 示例文稿：首次打开可一键体验 */
export const SAMPLE_TEXT = `# 没有雨的城市

## 引言

在这座城市里，雨是一种被审计的液体。每一滴水的下落都要经过市政厅的批准，未经登记的降水会被蒸发装置在半空拦截。市民们习惯了仰着头走路，不是为了看天，而是为了确认今天有没有谁偷偷下了雨。

## 水的经济学

城里流通两种货币：一种是信用点，另一种是水票。水票不记名、不挂失，黑市上常年溢价三成。经济学家说，一个城市的通胀水平，取决于它上个季度的蒸发量。

## 消失的职业

气象预报员是二十年前被裁撤的。他们的最后一任局长在离职采访中说：我们不是预测错了什么，我们是预测对了太多次。如今，看云成了一种需要许可证的爱好。

## 尾声

昨天深夜，城东下了十七秒钟的雨。没有人报告，也没有人受罚。第二天清晨，广场上聚集了上千人，他们伸出舌头，接住阳台上残留的水珠。有人说那是咸的，有人说那是甜的。市政厅至今没有给出解释。
`

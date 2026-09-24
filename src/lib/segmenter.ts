/**
 * 中文/中英混排断句。
 * 优先使用 Intl.Segmenter（Webview 内置，spec §7），降级为正则。
 * 规则：中文 。！？；… 断句；英文 . ! ? 断句；标点附着于前句。
 * 注意：切分过程不吞字符，块文本 join 后可无损还原原段落（含英文句间空格）。
 */

const hasSegmenter =
  typeof Intl !== 'undefined' &&
  typeof (Intl as unknown as { Segmenter?: unknown }).Segmenter === 'function'

let segmenter: Intl.Segmenter | null = null
if (hasSegmenter) {
  segmenter = new Intl.Segmenter('zh', { granularity: 'sentence' })
}

export function splitSentences(paragraph: string): string[] {
  const text = paragraph.replace(/^\s+/, '')
  if (!text) return []
  let parts: string[] = []
  if (segmenter) {
    for (const part of segmenter.segment(text)) {
      if (part.segment !== '') parts.push(part.segment)
    }
  }
  if (!parts.length) {
    // 降级：标点后 split，不消耗任何字符
    parts = text.split(/(?<=[。！？；…!?]+["'”’」』）)]*)/u).filter((s) => s !== '')
  }
  if (!parts.length) parts = [text]
  // 去掉首段的行首缩进空白，其余保持原样
  parts[0] = parts[0].replace(/^\s+/, '')
  return parts
}

/** 段落切分：按空行；无空行时整个输入视为一段 */
export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/^\s+|\s+$/g, ''))
    .filter(Boolean)
}

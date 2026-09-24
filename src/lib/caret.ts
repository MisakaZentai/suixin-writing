/**
 * 屏幕坐标 → 元素内的文本偏移。用于双击段落时，让编辑框的光标落在点击处。
 * Chromium / WebView2 用 caretRangeFromPoint，Firefox 用 caretPositionFromPoint。
 */
interface CaretDocument {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

export function caretOffsetFromPoint(root: HTMLElement, x: number, y: number): number | undefined {
  const doc = document as unknown as CaretDocument
  let node: Node | null = null
  let offset = 0
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y)
    node = pos?.offsetNode ?? null
    offset = pos?.offset ?? 0
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y)
    node = range?.startContainer ?? null
    offset = range?.startOffset ?? 0
  }
  if (!node || !root.contains(node)) return undefined
  if (node.nodeType !== Node.TEXT_NODE) return undefined
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let total = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return total + offset
    total += n.textContent?.length ?? 0
  }
  return undefined
}

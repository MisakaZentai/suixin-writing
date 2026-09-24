/**
 * 这次按键是否属于输入法组字。
 * Chromium 组字时 isComposing=true / key="Process"；WebKit（macOS 桌面版）在上屏的那次回车
 * 已经结束组字却仍报 keyCode 229——三种都要认，否则拼音输入法回车上屏会被当成"分段"。
 */
export function isImeKey(e: { isComposing?: boolean; key: string; keyCode?: number }): boolean {
  return Boolean(e.isComposing) || e.key === 'Process' || e.keyCode === 229
}

/** 短随机 id，合并/拆分后仍保持唯一 */
let counter = 0
export function uid(prefix: string): string {
  counter += 1
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`
}

export function nowISO(): string {
  return new Date().toISOString()
}

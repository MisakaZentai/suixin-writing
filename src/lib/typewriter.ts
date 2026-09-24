/**
 * 缓冲式打字机渲染器（design §3.3）：
 * - SSE 字符先入缓冲，rAF 按帧匀速吐出（默认每帧 2.6 字）；
 * - 积压 > 50 字提速到每帧 8 字追平，落后则降速；
 * - 每遇到句读做 30ms 微停顿；
 * - prefers-reduced-motion 时整段一次性给全。
 */
export interface TypewriterState {
  shown: string
  done: boolean
}

export class Typewriter {
  private buffer = ''
  private shown = ''
  private raf = 0
  private lastTs = 0
  private punctPauseUntil = 0
  private finished = false
  private listeners = new Set<(s: TypewriterState) => void>()

  constructor(private reducedMotion = false) {}

  subscribe(fn: (s: TypewriterState) => void): () => void {
    this.listeners.add(fn)
    fn(this.snapshot())
    return () => this.listeners.delete(fn)
  }

  private snapshot(): TypewriterState {
    return { shown: this.shown, done: this.finished }
  }

  private emit(): void {
    const snap = this.snapshot()
    for (const fn of this.listeners) fn(snap)
  }

  push(text: string): void {
    this.buffer += text
    if (!this.raf && !this.finished) {
      this.lastTs = 0
      this.raf = requestAnimationFrame(this.tick)
    }
  }

  /** 立即补全全部缓冲 */
  finish(): void {
    if (this.finished) return
    this.shown += this.buffer
    this.buffer = ''
    this.finished = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.emit()
  }

  abort(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.finished = true
    this.emit()
  }

  private tick = (ts: number): void => {
    if (this.finished) {
      this.raf = 0
      return
    }
    if (!this.lastTs) this.lastTs = ts
    const dt = Math.min(64, ts - this.lastTs)
    this.lastTs = ts

    if (ts < this.punctPauseUntil) {
      this.raf = requestAnimationFrame(this.tick)
      return
    }
    if (this.buffer.length === 0) {
      // 缓冲枯竭：等下一批 chunk（保持最后一帧）
      this.raf = requestAnimationFrame(this.tick)
      return
    }
    // 速度调节：水位策略
    const perFrame =
      this.buffer.length > 50 ? 8 : this.buffer.length < 3 ? 1.2 : 2.6
    const advance = this.reducedMotion
      ? this.buffer.length
      : Math.max(1, Math.round((perFrame * dt) / 16.7))
    const take = this.buffer.slice(0, advance)
    this.buffer = this.buffer.slice(advance)
    this.shown += take
    // 句读微停顿
    if (/[。！？；…!?]$/.test(take)) this.punctPauseUntil = ts + 30
    this.emit()
    this.raf = requestAnimationFrame(this.tick)
  }
}

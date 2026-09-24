/** rAF ease-in-out 平滑滚动（design §5.6：400ms 自定义曲线） */
export function smoothScrollTo(
  container: HTMLElement,
  targetTop: number,
  duration = 400
): void {
  const start = container.scrollTop
  const delta = targetTop - start
  if (Math.abs(delta) < 2) return
  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced) {
    container.scrollTop = targetTop
    return
  }
  const t0 = performance.now()
  const ease = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  const step = (now: number): void => {
    const t = Math.min(1, (now - t0) / duration)
    container.scrollTop = start + delta * ease(t)
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/** 键盘块导航的“最短距离”滚动：目标露出 80px 即止（design §6.2） */
export function revealBlock(
  container: HTMLElement,
  el: HTMLElement,
  margin = 80
): void {
  const cTop = container.scrollTop
  const cBottom = cTop + container.clientHeight
  const eTop = el.offsetTop
  const eBottom = eTop + el.offsetHeight
  if (eTop >= cTop + margin && eBottom <= cBottom - margin) return
  const target =
    eTop < cTop + margin
      ? Math.max(0, eTop - margin)
      : eBottom - container.clientHeight + margin
  smoothScrollTo(container, target)
}

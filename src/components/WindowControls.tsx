/**
 * 窗口按钮（最小化 / 最大化·还原 / 关闭）。Windows 桌面版去掉了系统标题栏，
 * 按钮画在顶栏右端，尺寸与悬停色照 Windows 11 的标题栏，颜色随界面主题。
 */
import { useEffect, useState } from 'react'

const win = async () => (await import('@tauri-apps/api/window')).getCurrentWindow()

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    let off: (() => void) | undefined
    void (async () => {
      const w = await win()
      const sync = async () => {
        const m = await w.isMaximized()
        if (alive) setMaximized(m)
      }
      await sync()
      const unlisten = await w.onResized(() => void sync())
      if (alive) off = unlisten
      else unlisten()
    })()
    return () => {
      alive = false
      off?.()
    }
  }, [])

  return (
    <div className="window-controls" role="group" aria-label="窗口">
      <button className="window-btn" tabIndex={-1} title="最小化" aria-label="最小化" onClick={() => void win().then((w) => w.minimize())}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        className="window-btn"
        tabIndex={-1}
        title={maximized ? '向下还原' : '最大化'}
        aria-label={maximized ? '向下还原' : '最大化'}
        onClick={() => void win().then((w) => w.toggleMaximize())}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <rect x="0.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" />
            <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <rect x="0.5" y="0.5" width="9" height="9" rx="1" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button className="window-btn close" tabIndex={-1} title="关闭" aria-label="关闭窗口" onClick={() => void win().then((w) => w.close())}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  )
}

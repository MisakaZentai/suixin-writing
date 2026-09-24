/**
 * 借本机已装的 Chrome / Edge / Chromium（无头模式），把 HTML 转成 PDF 或分页截图。
 * 通过 DevTools 协议（--remote-debugging-pipe，与 Playwright 相同的方式）控制：
 * 一个浏览器进程里完成打开、量高度、逐页截图、打印，不依赖标准输出。
 * 不额外下载浏览器；找不到时报错并提示用 SUIXIN_BROWSER 指定。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { AgentError } from '../src/agent/errors'
import { connectWs, type MiniSocket } from './ws'

type Env = Record<string, string | undefined>

/** Edge 的 Application\<版本号>\msedge.exe，新版本在前 */
function edgeVersioned(appDir: string): string[] {
  try {
    return readdirSync(appDir)
      .filter((n) => /^\d+(\.\d+)+$/.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(appDir, v, 'msedge.exe'))
  } catch {
    return []
  }
}

/**
 * 可用的浏览器，按优先顺序。Chrome / Chromium 在前：Edge 有更新待装时，
 * 外层的 msedge.exe 会把自己转交给新版本进程后立即退出，连不上；
 * 所以 Edge 同时列出带版本号的真实程序，由调用方逐个尝试。
 */
/** Windows 的环境变量名不分大小写；传进来的可能是普通对象（如 { PROGRAMFILES: … }） */
function envGet(env: Env, name: string): string | undefined {
  if (env[name] !== undefined || process.platform !== 'win32') return env[name]
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

export function browserCandidates(env: Env): string[] {
  const custom = envGet(env, 'SUIXIN_BROWSER')
  if (custom) return existsSync(custom) ? [custom] : []
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const roots = [envGet(env, 'ProgramFiles'), envGet(env, 'ProgramFiles(x86)'), envGet(env, 'LOCALAPPDATA')].filter(Boolean) as string[]
    for (const r of roots) candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    for (const r of roots) candidates.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'))
    for (const r of roots) {
      const app = path.join(r, 'Microsoft', 'Edge', 'Application')
      candidates.push(path.join(app, 'msedge.exe'), ...edgeVersioned(app))
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    )
  } else {
    for (const dir of (env.PATH ?? '').split(path.delimiter)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
        candidates.push(path.join(dir, name))
      }
    }
  }
  return [...new Set(candidates)].filter((c) => existsSync(c))
}

export function requireBrowser(env: Env): string[] {
  const list = browserCandidates(env)
  if (!list.length) {
    throw new AgentError(
      'UNSUPPORTED',
      '没找到 Chrome / Edge / Chromium，无法生成 PDF 或截图',
      '安装其中一个，或用环境变量 SUIXIN_BROWSER 指定浏览器可执行文件'
    )
  }
  return list
}

/** 启动后连不上（进程转交后退出）：换下一个候选 */
class LaunchFailed extends Error {}

/* ── DevTools 协议（管道，消息以 \0 分隔） ─────────────── */

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
}

/** DevTools 协议客户端；传输层（管道或 WebSocket）只负责收发一条条 JSON 文本 */
class Cdp {
  private id = 0
  private pending = new Map<number, Pending>()
  private listeners: ((m: { method: string; params: Record<string, unknown>; sessionId?: string }) => void)[] = []

  constructor(private write: (text: string) => void) {}

  receive(text: string) {
    const msg = JSON.parse(text)
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p?.reject(new Error(msg.error.message))
      else p?.resolve(msg.result ?? {})
    } else this.listeners.forEach((l) => l(msg))
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.id
    this.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  once(method: string, sessionId: string, timeout: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeout)
      const listener = (m: { method: string; sessionId?: string }) => {
        if (m.method === method && m.sessionId === sessionId) done()
      }
      function done() {
        clearTimeout(timer)
        resolve()
      }
      this.listeners.push(listener)
    })
  }

  failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e)
    this.pending.clear()
  }
}

interface PageSession {
  cdp: Cdp
  session: string
  /** 内容总高度（CSS 像素） */
  height: number
}

/**
 * 依次尝试各个浏览器，直到有一个连得上。每个浏览器先用管道连接；
 * 进程转交后退出（Edge 有更新待装时会这样）就改用端口连接——转交后的进程照样会把端口写进配置目录。
 */
async function withPage<T>(browsers: string[], htmlFile: string, width: number, viewportHeight: number, fn: (p: PageSession) => Promise<T>): Promise<T> {
  for (const browser of browsers) {
    for (const transport of ['pipe', 'port'] as const) {
      try {
        return await withPageOn(browser, transport, htmlFile, width, viewportHeight, fn)
      } catch (e) {
        if (!(e instanceof LaunchFailed)) throw e
      }
    }
  }
  throw new AgentError('UNSUPPORTED', '找到的浏览器都没能以无头模式启动', '安装 Chrome，或用 SUIXIN_BROWSER 指定浏览器可执行文件')
}

const LAUNCH_ARGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  '--mute-audio',
]

/** 端口模式：等浏览器把端口写进配置目录的 DevToolsActivePort，再用 WebSocket 连上 */
async function connectByPort(profile: string, cdpRef: { cdp: Cdp | null }): Promise<MiniSocket> {
  const file = path.join(profile, 'DevToolsActivePort')
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    const [port, wsPath] = text.split(/\r?\n/)
    if (port && wsPath) {
      const ws = await connectWs(`ws://127.0.0.1:${port.trim()}${wsPath.trim()}`)
      ws.onMessage((t) => cdpRef.cdp?.receive(t))
      return ws
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new LaunchFailed('没有等到 DevToolsActivePort')
}

/** 打开浏览器、加载页面、等图片与字体就绪，然后交给 fn */
async function withPageOn<T>(
  browser: string,
  transport: 'pipe' | 'port',
  htmlFile: string,
  width: number,
  viewportHeight: number,
  fn: (p: PageSession) => Promise<T>
): Promise<T> {
  // 临时配置目录：不碰作者自己的浏览器数据
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'suixin-browser-'))
  let proc: ChildProcess | null = null
  let ws: MiniSocket | null = null
  let connected = false
  try {
    const args = [...LAUNCH_ARGS, `--user-data-dir=${profile}`]
    let cdp: Cdp
    let lost: Promise<never>
    if (transport === 'pipe') {
      proc = spawn(browser, [...args, '--remote-debugging-pipe', 'about:blank'], {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const out = proc.stdio[3] as Writable
      const input = proc.stdio[4] as Readable
      cdp = new Cdp((text) => out.write(`${text}\0`))
      let buf = ''
      input.setEncoding('utf8')
      input.on('data', (chunk: string) => {
        buf += chunk
        let at: number
        while ((at = buf.indexOf('\0')) >= 0) {
          cdp.receive(buf.slice(0, at))
          buf = buf.slice(at + 1)
        }
      })
      lost = new Promise<never>((_, reject) =>
        proc!.once('exit', (code) => {
          const e = connected ? new AgentError('IO', `浏览器意外退出（${code}）`) : new LaunchFailed(browser)
          cdp.failAll(e)
          reject(e)
        })
      )
    } else {
      proc = spawn(browser, [...args, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', windowsHide: true })
      const ref: { cdp: Cdp | null } = { cdp: null }
      ws = await connectByPort(profile, ref)
      const socket = ws
      cdp = new Cdp((text) => socket.send(text))
      ref.cdp = cdp
      // 进程可能已经转交后退出，以连接断开为准
      lost = new Promise<never>((_, reject) =>
        socket.onClose(() => {
          const e = new AgentError('IO', '与浏览器的连接断开')
          cdp.failAll(e)
          reject(e)
        })
      )
    }
    const work = (async () => {
      // 握手超时：连得上就清掉计时器，别让它拖住进程
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        cdp.send('Browser.getVersion'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new LaunchFailed(browser)), 15_000)
        }),
      ]).finally(() => clearTimeout(timer))
      connected = true
      const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }
      const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
      const s = sessionId
      await cdp.send('Page.enable', {}, s)
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: viewportHeight, deviceScaleFactor: 1, mobile: false }, s)
      const loaded = cdp.once('Page.loadEventFired', s, 15_000)
      await cdp.send('Page.navigate', { url: pathToFileURL(htmlFile).href }, s)
      await loaded
      // 等字体与图片都就绪
      await cdp.send(
        'Runtime.evaluate',
        {
          expression:
            'Promise.all([document.fonts.ready, ...Array.from(document.images).map(i => i.decode().catch(() => {}))]).then(() => true)',
          awaitPromise: true,
        },
        s
      )
      const metrics = (await cdp.send('Page.getLayoutMetrics', {}, s)) as { cssContentSize?: { height: number }; contentSize: { height: number } }
      const height = Math.ceil((metrics.cssContentSize ?? metrics.contentSize).height)
      const result = await fn({ cdp, session: s, height })
      // 端口模式下进程可能已转交，只能请浏览器自己退出
      let closeTimer: NodeJS.Timeout | undefined
      await Promise.race([
        cdp.send('Browser.close').catch(() => {}),
        new Promise((r) => {
          closeTimer = setTimeout(r, 3000)
        }),
      ]).finally(() => clearTimeout(closeTimer))
      return result
    })()
    return await Promise.race([work, lost])
  } finally {
    ws?.close()
    if (proc && proc.exitCode === null) proc.kill()
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
}

export async function htmlToPdf(browser: string[], htmlFile: string, pdfOut: string): Promise<void> {
  await withPage(browser, htmlFile, 820, 1200, async ({ cdp, session }) => {
    const { data } = (await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true }, session)) as { data: string }
    await fs.writeFile(pdfOut, Buffer.from(data, 'base64'))
  })
}

/** 分页截图：每页 width × pageHeight，最后一页按实际高度 */
export async function htmlToPngPages(
  browser: string[],
  htmlFile: string,
  outDir: string,
  opts: { width: number; pageHeight: number; maxPages: number; firstPage?: number; prefix?: string }
): Promise<{ pages: string[]; total: number; height: number }> {
  await fs.mkdir(outDir, { recursive: true })
  return withPage(browser, htmlFile, opts.width, opts.pageHeight, async ({ cdp, session, height }) => {
    const total = Math.max(1, Math.ceil(height / opts.pageHeight))
    const first = Math.min(Math.max(0, opts.firstPage ?? 0), total - 1)
    const last = Math.min(total, first + opts.maxPages)
    const pages: string[] = []
    for (let i = first; i < last; i++) {
      const y = i * opts.pageHeight
      const { data } = (await cdp.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y, width: opts.width, height: Math.min(opts.pageHeight, height - y), scale: 1 },
        },
        session
      )) as { data: string }
      const out = path.join(outDir, `${opts.prefix ?? 'page'}-${String(i + 1).padStart(2, '0')}.png`)
      await fs.writeFile(out, Buffer.from(data, 'base64'))
      pages.push(out)
    }
    return { pages, total, height }
  })
}

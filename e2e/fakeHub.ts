/**
 * 测试用的实时桥服务：与 src-tauri/src/bridge.rs 同一套 HTTP 约定
 * （令牌、Host 校验、POST /rpc、events.wait 长轮询），请求交给传入的 handle。
 * 端到端测试里 handle 把请求转进浏览器页面，单元测试里直接给固定回复。
 */
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BridgeEvent, BridgeRequest, BridgeResponse } from '../src/bridge/protocol'

export interface FakeHub {
  port: number
  token: string
  /** bridge.json 的路径：设为环境变量 SUIXIN_BRIDGE 即可让命令行找到它 */
  discoveryFile: string
  requests: BridgeRequest[]
  publish: (event: BridgeEvent | Record<string, unknown>) => void
  close: () => Promise<void>
}

export async function startFakeHub(
  dir: string,
  handle: (req: BridgeRequest) => Promise<BridgeResponse>
): Promise<FakeHub> {
  const token = 'test-token-0123456789abcdef'
  const events: Record<string, unknown>[] = []
  let nextSeq = 1
  const waiters = new Set<() => void>()
  const requests: BridgeRequest[] = []

  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const port = (server.address() as { port: number }).port
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      return send(403, { ok: false, error: { code: 'FORBIDDEN', message: '只接受本机请求' } })
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      return send(401, { ok: false, error: { code: 'UNAUTHORIZED', message: '令牌不对' } })
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      const msg = JSON.parse(raw) as BridgeRequest
      requests.push(msg)
      if (msg.method === 'hello') return send(200, { ok: true, result: { app: '随心写作', ready: true } })
      if (msg.method === 'events.wait') {
        const p = msg.params ?? {}
        const since = typeof p.since === 'number' ? p.since : nextSeq - 1
        const types = Array.isArray(p.types) ? (p.types as string[]) : null
        const deadline = Date.now() + Math.min(typeof p.timeout === 'number' ? p.timeout : 25_000, 30_000)
        const pick = () =>
          events.filter((e) => (e.seq as number) > since && (!types || types.includes(e.type as string)))
        const finish = () => send(200, { ok: true, result: { cursor: nextSeq - 1, events: pick() } })
        if (pick().length) return finish()
        await new Promise<void>((resolve) => {
          const wake = () => {
            if (pick().length || Date.now() >= deadline) {
              waiters.delete(wake)
              clearTimeout(timer)
              resolve()
            }
          }
          const timer = setTimeout(() => {
            waiters.delete(wake)
            resolve()
          }, deadline - Date.now())
          waiters.add(wake)
        })
        return finish()
      }
      try {
        const out = await handle(msg)
        send(200, out ?? { ok: false, error: { code: 'IO', message: '测试替身：页面没有回复' } })
      } catch (e) {
        // 转交失败（如页面里抛错）：如实报出来，别让连接挂着
        send(200, { ok: false, error: { code: 'IO', message: `测试替身转交失败：${(e as Error).message}` } })
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const discoveryFile = path.join(dir, 'bridge.json')
  writeFileSync(discoveryFile, JSON.stringify({ port, token, pid: process.pid, version: 1 }))

  return {
    port,
    token,
    discoveryFile,
    requests,
    publish: (event) => {
      events.push({ ...event, seq: nextSeq++ })
      for (const w of [...waiters]) w()
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.()
        server.close(() => r())
      }),
  }
}

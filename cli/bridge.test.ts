import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from './suixin'
import { startFakeHub, type FakeHub } from '../e2e/fakeHub'
import type { BridgeRequest, BridgeResponse } from '../src/bridge/protocol'

const MD = '# 城市\n\n雨是一种被审计的液体。\n\n市政厅没有解释。\n'

let dir = ''
let hub: FakeHub | null = null
let reply: (req: BridgeRequest) => BridgeResponse = () => ({ ok: true, result: { handled: false } })
const file = () => path.join(dir, '稿.suixin.json')

async function cli(args: string[], env: Record<string, string> = {}) {
  let out = ''
  const code = await runCli(args, {
    stdout: (t) => (out += t),
    stderr: () => {},
    readStdin: async () => '',
    env: { SUIXIN_AGENT: 'Codex', ...(hub ? { SUIXIN_BRIDGE: hub.discoveryFile } : {}), ...env },
    cwd: dir,
  })
  let json: any = null
  try {
    json = JSON.parse(out)
  } catch {
    /* Markdown 输出 */
  }
  return { code, out, json }
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'suixin-bridge-'))
  writeFileSync(path.join(dir, 'a.md'), MD)
  hub = null
  expect((await cli(['new', '稿.suixin.json', '--from', 'a.md'])).code).toBe(0)
  hub = await startFakeHub(dir, async (req) => reply(req))
})

afterEach(async () => {
  await hub?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('命令行经实时桥交给 App', () => {
  it('App 正打开这篇：操作交给 App，文件不由命令行写', async () => {
    const before = readFileSync(file(), 'utf8')
    reply = () => ({ ok: true, result: { handled: true, ok: true, via: 'app', mode: 'propose', written: true, results: [] } })
    const r = await cli(['replace', '稿.suixin.json', '--quote', '被审计', '--text', '要登记'])
    expect(r.json).toMatchObject({ ok: true, via: 'app', written: true })
    expect(readFileSync(file(), 'utf8')).toBe(before)
    const req = hub!.requests.find((x) => x.method === 'doc.operate')!
    expect(req.agent).toBe('Codex')
    expect(req.params).toMatchObject({ file: file(), calls: [{ op: 'replace', text: '要登记' }], direct: false })
  })

  it('App 开着但不是这篇：退回直接读写文件', async () => {
    reply = () => ({ ok: true, result: { handled: false } })
    const r = await cli(['replace', '稿.suixin.json', '--quote', '被审计', '--text', '要登记'])
    expect(r.json).toMatchObject({ ok: true, written: true })
    expect(r.json.via).toBeUndefined()
    expect(JSON.parse(readFileSync(file(), 'utf8')).suggestions).toHaveLength(1)
  })

  it('App 拒绝（如未授权）：原样报错，不绕过去写文件', async () => {
    const before = readFileSync(file(), 'utf8')
    reply = () => ({ ok: false, error: { code: 'NOT_AUTHORIZED', message: '作者没有授权直接修改这篇文稿', hint: '…' } })
    const r = await cli(['replace', '稿.suixin.json', '--quote', '被审计', '--text', 'x', '--direct'])
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('NOT_AUTHORIZED')
    expect(readFileSync(file(), 'utf8')).toBe(before)
  })

  it('@ 表示 App 里打开的那篇；App 没开时报 UNAVAILABLE', async () => {
    reply = (req) => ({ ok: true, result: { handled: true, ok: true, via: 'app', echo: req.params.file } })
    expect((await cli(['outline', '@'])).json).toMatchObject({ via: 'app', echo: null })
    await hub!.close()
    const offline = await cli(['outline', '@'])
    expect(offline.code).toBe(1)
    expect(offline.json.error.code).toBe('UNAVAILABLE')
    // 用文件路径则照常工作
    expect((await cli(['outline', '稿.suixin.json'])).json.ok).toBe(true)
  })

  it('bridge.json 过期（令牌不对）：当作 App 不在', async () => {
    writeFileSync(hub!.discoveryFile, JSON.stringify({ port: hub!.port, token: 'stale', pid: 1, version: 1 }))
    const r = await cli(['replace', '稿.suixin.json', '--quote', '被审计', '--text', '要登记'])
    expect(r.json).toMatchObject({ ok: true, written: true })
    expect((await cli(['status'])).json).toMatchObject({ ok: true, online: false })
  })

  it('SUIXIN_NO_BRIDGE=1 强制只读写文件', async () => {
    reply = () => ({ ok: true, result: { handled: true, ok: true, via: 'app' } })
    const r = await cli(['info', '稿.suixin.json'], { SUIXIN_NO_BRIDGE: '1' })
    expect(r.json.via).toBeUndefined()
    expect(hub!.requests).toHaveLength(0)
  })

  it('status / selection / request-access 走实时桥', async () => {
    reply = (req) =>
      req.method === 'app.status'
        ? { ok: true, result: { app: '随心写作', document: { id: 'd1', title: '城市', path: null } } }
        : req.method === 'doc.selection'
          ? { ok: true, result: { selection: { text: '被审计', target: { quote: '被审计' } } } }
          : { ok: true, result: { granted: req.params.reason === '要调整章节' } }
    expect((await cli(['status'])).json).toMatchObject({ ok: true, online: true, document: { title: '城市' } })
    expect((await cli(['selection'])).json.selection.target).toEqual({ quote: '被审计' })
    expect((await cli(['request-access', '--why', '要调整章节'])).code).toBe(0)
    const denied = await cli(['request-access'])
    expect(denied.code).toBe(1)
    expect(denied.json).toMatchObject({ ok: false, granted: false })
  })

  it('wait：长轮询拿到事件，游标接着往后取，可按类型过滤', async () => {
    const pending = cli(['wait', '--timeout', '5'])
    await new Promise((r) => setTimeout(r, 100))
    hub!.publish({ type: 'suggestion.resolved', at: '', document: null, suggestion: 's1', state: 'accepted' })
    const first = (await pending).json
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({ type: 'suggestion.resolved', state: 'accepted' })
    hub!.publish({ type: 'selection.changed', at: '', document: null })
    hub!.publish({ type: 'task.created', at: '', document: null })
    const next = (await cli(['wait', '--since', String(first.cursor), '--types', 'task.created', '--timeout', '1'])).json
    expect(next.events.map((e: { type: string }) => e.type)).toEqual(['task.created'])
    const empty = (await cli(['wait', '--since', String(next.cursor), '--timeout', '0.2'])).json
    expect(empty.events).toEqual([])
  })
})

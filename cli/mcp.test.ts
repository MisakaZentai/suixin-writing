import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { authorFromClient, createMcpServer } from './mcp'
import { projectFromText, serializeProject } from '../src/lib/project'

const MD = '# 城市\n\n## 引言\n\n雨是一种被审计的液体。市政厅批准每一滴水。\n\n## 尾声\n\n市政厅没有解释。\n'

let dir = ''
const file = () => path.join(dir, '稿.suixin.json')
const saved = () => JSON.parse(readFileSync(file(), 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'suixin-mcp-'))
  writeFileSync(file(), serializeProject(projectFromText(MD, '城市').project))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function session(opts: { author?: string; defaultFile?: string } = {}, client = 'claude-code') {
  const server = createMcpServer({ cwd: dir, env: {}, ...opts })
  let id = 0
  const rpc = async (method: string, params?: Record<string, unknown>) => (await server.handle({ jsonrpc: '2.0', id: ++id, method, params })) as any
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: client, version: '1' } })
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const call = async (name: string, args: object) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result
    return { isError: r.isError as boolean, body: JSON.parse(r.content[0].text) }
  }
  return { rpc, call, init }
}

describe('suixin mcp', () => {
  it('initialize 回应协议版本、能力与使用说明；通知不回复', async () => {
    const { init } = await session()
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(init.result.capabilities.tools).toBeDefined()
    expect(init.result.instructions).toContain('建议')
    const server = createMcpServer({ cwd: dir, env: {} })
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    const old = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    expect((old as any).result.protocolVersion).toBe('2025-06-18')
  })

  it('tools/list 包含全部操作与实时协作工具，写操作带 direct / dry_run', async () => {
    const { rpc } = await session()
    const tools = (await rpc('tools/list')).result.tools
    const names = tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'outline', 'read', 'replace', 'note', 'rename_heading', 'apply', 'new_document', 'guide',
        'tasks', 'claim_task', 'complete_task', 'app_status', 'get_selection', 'wait_for_events', 'request_direct_access',
      ])
    )
    const replace = tools.find((t: { name: string }) => t.name === 'replace')
    // file 可省略：省略时是作者在 App 里正在看的那篇
    expect(replace.inputSchema.required).toEqual(['target', 'text'])
    expect(replace.inputSchema.properties.file).toBeDefined()
    expect(replace.inputSchema.properties.direct).toBeDefined()
    expect(tools.find((t: { name: string }) => t.name === 'outline').annotations.readOnlyHint).toBe(true)
  })

  it('App 没开时：省略 file 报 UNAVAILABLE 并提示给出路径；app_status 报告离线', async () => {
    const { call } = await session()
    const r = await call('outline', {})
    expect(r.isError).toBe(true)
    expect(r.body.error.code).toBe('UNAVAILABLE')
    expect(r.body.error.hint).toContain('.suixin.json')
    expect((await call('app_status', {})).body).toMatchObject({ ok: true, online: false })
    expect((await call('get_selection', {})).body.error.code).toBe('UNAVAILABLE')
  })

  it('replace 按客户端署名写入建议', async () => {
    const { call } = await session()
    const r = await call('replace', { file: '稿.suixin.json', target: { quote: '被审计' }, text: '要登记', why: '更口语' })
    expect(r).toMatchObject({ isError: false, body: { ok: true, mode: 'propose', written: true } })
    expect(saved().suggestions[0]).toMatchObject({ author: { name: 'Claude Code' }, why: '更口语', state: 'pending' })
  })

  it('失败以 isError 结果返回，带错误码与候选', async () => {
    const { call } = await session()
    const r = await call('replace', { file: '稿.suixin.json', target: { quote: '市政厅' }, text: '议会' })
    expect(r.isError).toBe(true)
    expect(r.body.error.code).toBe('AMBIGUOUS')
    expect(r.body.error.candidates).toHaveLength(2)
    const denied = await call('rename_heading', { file: '稿.suixin.json', heading: '尾声', text: '后记', direct: true })
    expect(denied.body.error.code).toBe('NOT_AUTHORIZED')
  })

  it('默认文稿、apply 批量与 dry_run', async () => {
    const { call, rpc } = await session({ defaultFile: file(), author: 'Kimi' }, 'kimi-cli')
    const tools = (await rpc('tools/list')).result.tools
    expect(tools.find((t: { name: string }) => t.name === 'replace').inputSchema.required).not.toContain('file')
    const ops = [
      { op: 'replace', target: { quote: '没有解释' }, text: '从不解释' },
      { op: 'note', target: { section: '引言' }, issue: '太短', advice: '补一句' },
    ]
    const dry = await call('apply', { ops, dry_run: true })
    expect(dry.body).toMatchObject({ ok: true, written: false, dryRun: true })
    expect(saved().suggestions).toHaveLength(0)
    const real = await call('apply', { ops })
    expect(real.body.written).toBe(true)
    expect(saved().suggestions.map((s: { author: { name: string } }) => s.author.name)).toEqual(['Kimi', 'Kimi'])
  })

  it('new_document 新建且不覆盖；未知方法与工具', async () => {
    const { call, rpc } = await session()
    const r = await call('new_document', { file: '新.suixin.json', markdown: '# 新\n\n第一段。' })
    expect(r.body).toMatchObject({ ok: true, title: '新' })
    expect((await call('new_document', { file: '新.suixin.json' })).body.error.code).toBe('CONFLICT')
    expect((await rpc('resources/list')).error.code).toBe(-32601)
    expect((await rpc('tools/call', { name: 'nope', arguments: {} })).error.code).toBe(-32602)
  })

  it('按客户端名推断署名', () => {
    expect(authorFromClient('claude-code')).toBe('Claude Code')
    expect(authorFromClient('codex-mcp-client')).toBe('Codex')
    expect(authorFromClient(undefined)).toBe('Agent')
  })
})

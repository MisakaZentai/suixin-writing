import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from './suixin'
import { createMcpServer } from './mcp'
import { startFakeHub } from '../e2e/fakeHub'

const MD = '# 城市\n\n## 引言\n\n雨是一种被审计的液体。\n\n## 尾声\n\n市政厅没有解释。\n'
// 2×3 的 PNG（只需文件头正确）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGP8z8DwnwEIGBkZGQAjAgMBqUKJ3QAAAABJRU5ErkJggg==',
  'base64'
)

let dir = ''
const file = () => path.join(dir, '稿.suixin.json')
const saved = () => JSON.parse(readFileSync(file(), 'utf8'))

async function cli(args: string[], env: Record<string, string> = {}) {
  let out = ''
  const code = await runCli(args, {
    stdout: (t) => (out += t),
    stderr: () => {},
    readStdin: async () => '',
    env: { SUIXIN_AGENT: 'Codex', ...env },
    cwd: dir,
  })
  return { code, json: JSON.parse(out) }
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'suixin-img-'))
  writeFileSync(path.join(dir, 'a.md'), MD)
  writeFileSync(path.join(dir, 'pic.png'), PNG)
  await cli(['new', '稿.suixin.json', '--from', 'a.md'])
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('agent 插图与看图（文件模式）', () => {
  it('image add：图片存进 稿.assets/，以待确认建议插入指定位置', async () => {
    const r = await cli(['image', 'add', '稿.suixin.json', 'pic.png', '--after-section', '引言', '--caption', '雨中的市政厅', '--why', '配图'])
    expect(r.json).toMatchObject({ ok: true, mode: 'propose', written: true, image: { width: 2, height: 3 } })
    expect(r.json.image.src).toMatch(/^稿\.assets\/[0-9a-f]{16}\.png$/)
    expect(readFileSync(path.join(dir, r.json.image.src))).toEqual(PNG)
    const s = saved().suggestions[0]
    expect(s).toMatchObject({ state: 'pending', proposed: `![雨中的市政厅](${r.json.image.src})`, why: '配图', author: { name: 'Codex' } })
    // 同一张图再插一次：不重复存
    await cli(['image', 'add', '稿.suixin.json', 'pic.png'])
    expect(readdirSync(path.join(dir, '稿.assets'))).toHaveLength(1)
  })

  it('images / read 给出图注、绝对路径与尺寸；image show 给出可直接查看的文件', async () => {
    const d = saved()
    d.meta.agentAccess = 'direct'
    writeFileSync(file(), JSON.stringify(d))
    const added = await cli(['image', 'add', '稿.suixin.json', 'pic.png', '--after', 'end', '--caption', '尾图', '--direct'])
    expect(added.json.mode).toBe('direct')
    const list = (await cli(['images', '稿.suixin.json'])).json.images
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ type: 'image', caption: '尾图', exists: true, width: 2, height: 3, bytes: PNG.length })
    expect(list[0].path).toBe(path.join(dir, added.json.image.src))
    const shown = (await cli(['image', 'show', '稿.suixin.json', '--block', list[0].id])).json
    expect(shown).toMatchObject({ ok: true, caption: '尾图', path: list[0].path, mime: 'image/png', width: 2 })
    const info = (await cli(['info', '稿.suixin.json'])).json.results[0]
    expect(info).toMatchObject({ images: 1, paragraphs: 2, headings: 2 })
  })

  it('dry-run 不写图片；不是图片的文件被拒绝', async () => {
    const dry = await cli(['image', 'add', '稿.suixin.json', 'pic.png', '--dry-run'])
    expect(dry.json).toMatchObject({ ok: true, written: false, dryRun: true })
    expect(existsSync(path.join(dir, '稿.assets'))).toBe(false)
    const bad = await cli(['image', 'add', '稿.suixin.json', 'a.md'])
    expect(bad.json.error.code).toBe('INVALID_PARAMS')
  })
})

describe('MCP 看图', () => {
  it('insert_image 插图；view_image 直接返回图像内容', async () => {
    const server = createMcpServer({ cwd: dir, env: {}, author: 'Claude Code', defaultFile: file() })
    const call = async (name: string, args: object) =>
      ((await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as any).result
    const d = saved()
    d.meta.agentAccess = 'direct'
    writeFileSync(file(), JSON.stringify(d))
    const ins = await call('insert_image', { image: 'pic.png', caption: '图一', direct: true, after: { section: '尾声' } })
    expect(ins.isError).toBe(false)
    const images = JSON.parse((await call('images', {})).content[0].text).images
    const shown = await call('view_image', { block: images[0].id })
    expect(shown.content[0].type).toBe('text')
    expect(JSON.parse(shown.content[0].text)).toMatchObject({ caption: '图一', width: 2, height: 3 })
    expect(shown.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') })
    const notImage = await call('view_image', { block: saved().blocks[1].id })
    expect(notImage.isError).toBe(true)
  })
})

describe('App 开着：图片交给 App 存取', () => {
  it('asset.put 由 App 存图并返回路径；命令行不写文件旁边的文件夹', async () => {
    const calls: string[] = []
    const hub = await startFakeHub(dir, async (req) => {
      calls.push(req.method)
      if (req.method === 'asset.put') return { ok: true, result: { handled: true, src: 'd_1.assets/abcd.png' } }
      if (req.method === 'asset.read') return { ok: true, result: { handled: true, data: PNG.toString('base64'), path: null } }
      if (req.method === 'doc.operate') return { ok: true, result: { handled: true, ok: true, via: 'app', results: [{ blocks: [{ id: 'b1', type: 'image', src: 'd_1.assets/abcd.png', caption: '图' }] }] } }
      return { ok: false, error: { code: 'UNSUPPORTED', message: req.method } }
    })
    try {
      const env = { SUIXIN_BRIDGE: hub.discoveryFile }
      const r = await cli(['image', 'add', '@', 'pic.png', '--caption', '图'], env)
      expect(r.json).toMatchObject({ ok: true, via: 'app', image: { src: 'd_1.assets/abcd.png' } })
      expect(hub.requests.find((x) => x.method === 'doc.operate')!.params.calls).toEqual([
        { op: 'insert', after: 'end', text: '![图](d_1.assets/abcd.png)' },
      ])
      expect(existsSync(path.join(dir, '稿.assets'))).toBe(false)
      // 浏览器模式的 App 没有文件路径：写一份出来给模型看
      const shown = (await cli(['image', 'show', '@', '--block', 'b1', '-o', 'out.png'], env)).json
      expect(shown.path).toBe(path.join(dir, 'out.png'))
      expect(readFileSync(path.join(dir, 'out.png'))).toEqual(PNG)
      expect(calls).toEqual(['asset.put', 'doc.operate', 'doc.operate', 'asset.read'])
    } finally {
      await hub.close()
    }
  })
})

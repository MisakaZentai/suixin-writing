import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from './suixin'
import { createMcpServer } from './mcp'
import { browserCandidates } from './browser'
import { imageSize } from '../src/lib/images'

const hasBrowser = browserCandidates(process.env).length > 0
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const long = '这是一段用来撑长篇幅的文字，'.repeat(40)
const MD = `# 城市\n\n## 引言\n\n雨是**被审计**的液体。\n\n## 很长的一节\n\n${Array(10).fill(long).join('\n\n')}\n`

let dir = ''
const file = () => path.join(dir, '稿.suixin.json')

async function cli(args: string[]) {
  let out = ''
  const code = await runCli(args, { stdout: (t) => (out += t), stderr: () => {}, readStdin: async () => '', env: { ...process.env, SUIXIN_NO_BRIDGE: '1', SUIXIN_AGENT: 'Codex' }, cwd: dir })
  let json: any = null
  try {
    json = JSON.parse(out)
  } catch {
    /* html 输出到标准输出 */
  }
  return { code, out, json }
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'suixin-render-'))
  writeFileSync(path.join(dir, 'a.md'), MD)
  writeFileSync(path.join(dir, 'pic.png'), PNG)
  await cli(['new', '稿.suixin.json', '--from', 'a.md'])
  const d = JSON.parse(readFileSync(file(), 'utf8'))
  d.meta.agentAccess = 'direct'
  writeFileSync(file(), JSON.stringify(d))
  await cli(['image', 'add', '稿.suixin.json', 'pic.png', '--after-section', '引言', '--caption', '图一', '--direct'])
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('导出', () => {
  it('Markdown：图片复制到输出旁边的 .assets/，路径随之改写', async () => {
    const r = await cli(['export', '稿.suixin.json', '--format', 'md', '-o', 'out/文章.md'])
    expect(r.json).toMatchObject({ ok: true, images: 1, missing: [] })
    const md = readFileSync(path.join(dir, 'out', '文章.md'), 'utf8')
    const m = /!\[图一\]\((文章\.assets\/[0-9a-f]{16}\.png)\)/.exec(md)
    expect(m).not.toBeNull()
    expect(readFileSync(path.join(dir, 'out', m![1]))).toEqual(PNG)
    // 不带 -o：照旧输出到标准输出，路径保持文稿里的写法
    expect((await cli(['export', '稿.suixin.json'])).out).toContain('](稿.assets/')
  })

  it('HTML：单文件，图片内嵌，Markdown 已渲染', async () => {
    const r = await cli(['export', '稿.suixin.json', '--format', 'html', '--style', 'zhihu'])
    expect(r.out).toMatch(/^<!doctype html>/)
    expect(r.out).toContain(`<img src="data:image/png;base64,${PNG.toString('base64')}" alt="图一">`)
    expect(r.out).toContain('<strong>被审计</strong>')
    expect((await cli(['export', '稿.suixin.json', '--format', 'html', '--style', 'fancy'])).json.error.code).toBe('INVALID_PARAMS')
  })

  it.skipIf(!hasBrowser)('PDF 借本机浏览器生成', async () => {
    const r = await cli(['export', '稿.suixin.json', '--format', 'pdf', '-o', 'out.pdf'])
    expect(r.json, JSON.stringify(r.json)).toMatchObject({ ok: true })
    expect(readFileSync(path.join(dir, 'out.pdf')).subarray(0, 5).toString()).toBe('%PDF-')
  }, 60_000)
})

describe.skipIf(!hasBrowser)('排版截图', () => {
  it('按页截图：量出全文高度，可翻页，可只看一节', async () => {
    const all = (await cli(['render', '稿.suixin.json', '--width', '600', '--page-height', '800', '-o', 'pages'])).json
    expect(all.ok).toBe(true)
    expect(all.total).toBeGreaterThan(2)
    expect(all.pages).toHaveLength(Math.min(6, all.total))
    const first = imageSize(readFileSync(all.pages[0]))!
    expect(first).toEqual({ width: 600, height: 800 })
    const later = (await cli(['render', '稿.suixin.json', '--width', '600', '--page-height', '800', '--page', '2', '--pages', '1', '-o', 'p2'])).json
    expect(later.pages).toHaveLength(1)
    expect(path.basename(later.pages[0])).toBe('page-02.png')
    const section = (await cli(['render', '稿.suixin.json', '--section', '引言', '--width', '600', '--page-height', '800', '-o', 's'])).json
    expect(section.total).toBe(1)
  }, 90_000)

  it('MCP render_preview 直接返回截图图像', async () => {
    const server = createMcpServer({ cwd: dir, env: { ...process.env, SUIXIN_NO_BRIDGE: '1' }, defaultFile: file() })
    const r = ((await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'render_preview', arguments: { style: 'zhihu', pages: 1 } } })) as any).result
    expect(r.isError).toBe(false)
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true })
    expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(imageSize(Buffer.from(r.content[1].data, 'base64'))!.width).toBe(820)
    const exported = ((await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'export_document', arguments: { format: 'html', output: 'x.html' } } })) as any).result
    expect(exported.isError).toBe(false)
    expect(existsSync(path.join(dir, 'x.html'))).toBe(true)
  }, 60_000)
})

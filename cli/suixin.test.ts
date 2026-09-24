import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from './suixin'

const MD = '# 城市\n\n## 引言\n\n雨是一种被审计的液体。市政厅批准每一滴水。\n\n## 尾声\n\n市政厅没有解释。\n'

let dir = ''
let file = ''

async function cli(args: string[], stdin = '', env: Record<string, string> = {}) {
  let out = ''
  const code = await runCli(args, {
    stdout: (t) => (out += t),
    stderr: () => {},
    readStdin: async () => stdin,
    env,
    cwd: dir,
  })
  let json: any = null
  try {
    json = JSON.parse(out)
  } catch {
    /* 非 JSON 输出（export / --markdown） */
  }
  return { code, out, json }
}

const saved = () => JSON.parse(readFileSync(file, 'utf8'))

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'suixin-cli-'))
  writeFileSync(path.join(dir, 'a.md'), MD)
  file = path.join(dir, '稿.suixin.json')
  expect((await cli(['new', '稿.suixin.json', '--from', 'a.md'])).code).toBe(0)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('suixin 命令行', () => {
  it('--help 退出码为 0，什么都不给才是用法错误', async () => {
    const help = await cli(['--help'])
    expect(help.code).toBe(0)
    expect(help.out).toContain('suixin guide')
    expect((await cli([])).code).toBe(2)
  })

  it('new 从 Markdown 建工程；export 原样导出', async () => {
    const r = await cli(['export', '稿.suixin.json'])
    expect(r.out).toBe(MD)
  })

  it('outline / read --markdown', async () => {
    const outline = await cli(['outline', '稿.suixin.json'])
    expect(outline.json.results[0].headings.map((h: { title: string }) => h.title)).toEqual(['引言', '尾声'])
    const md = await cli(['read', '稿.suixin.json', '--markdown'])
    expect(md.out).toBe(MD + '\n')
  })

  it('replace 默认只写入署名建议，正文不变', async () => {
    const r = await cli(['replace', '稿.suixin.json', '--quote', '被审计', '--text', '要登记', '--why', '更具体'], '', {
      SUIXIN_AGENT: 'Codex',
    })
    expect(r.code).toBe(0)
    expect(r.json).toMatchObject({ ok: true, mode: 'propose', written: true })
    const data = saved()
    expect(data.suggestions[0]).toMatchObject({ state: 'pending', author: { name: 'Codex' }, why: '更具体' })
    expect((await cli(['export', '稿.suixin.json'])).out).toBe(MD)
  })

  it('flavor：检查整篇与一段待提交的文字；不改文件', async () => {
    const before = readFileSync(file, 'utf8')
    const all = await cli(['flavor', '稿.suixin.json', '--genre', 'fiction'])
    expect(all.code).toBe(0)
    expect(all.json.results[0]).toMatchObject({ genre: 'fiction', baseline: '内置' })
    const text = await cli(['flavor', '稿.suixin.json', '--text', '他停下来——不是累了，是不想再走。'])
    expect(text.json.results[0].hits.map((h: { rule: string }) => h.rule).sort()).toEqual(['em_dash', 'neg_correction'])
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('baseline：用作者原文建立个人基线，flavor 按它计算；默认、删除', async () => {
    const env = { SUIXIN_BASELINES: path.join(dir, 'baselines.json') }
    writeFileSync(path.join(dir, '我的.txt'), '风不是吹，而是推。雨不是下，而是砸。\n\n我把伞收起来，走进楼道。\n'.repeat(30))
    expect((await cli(['baseline'], '', env)).json).toMatchObject({ ok: true, default: '内置', baselines: [] })
    const built = await cli(['baseline', 'build', '我', '我的.txt'], '', env)
    expect(built.code).toBe(0)
    expect(built.json).toMatchObject({ ok: true, name: '我', counts: { neg_correction: 60 } })
    expect(built.json.warnings.join('')).toContain('AI 味指数') // 原文本身套路很重：提醒，但照样建立
    // 第一份基线自动成为默认
    const listed = await cli(['baseline', 'list'], '', env)
    expect(listed.json.default).toBe('我')
    const text = ['flavor', '稿.suixin.json', '--text', '这里的冬天不是冷，而是湿。墙角长出一层白霜，被子怎么晒都是潮的。']
    const mine = (await cli(text, '', env)).json.results[0]
    const builtin = (await cli([...text, '--baseline', '内置'], '', env)).json.results[0]
    expect(mine.index).toBeLessThan(builtin.index)
    expect((await cli([...text, '--baseline', '没有'], '', env)).json.error.code).toBe('NOT_FOUND')
    expect((await cli(['baseline', 'default', '内置'], '', env)).json).toMatchObject({ ok: true, default: '内置' })
    expect((await cli(['baseline', 'remove', '我'], '', env)).json).toMatchObject({ ok: true, removed: '我' })
    expect(JSON.parse(readFileSync(env.SUIXIN_BASELINES, 'utf8')).baselines).toEqual([])
  })

  it('引文不唯一时退出码非 0 并给出候选', async () => {
    const r = await cli(['replace', '稿.suixin.json', '--quote', '市政厅', '--text', '议会'])
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('AMBIGUOUS')
    expect(r.json.error.candidates).toHaveLength(2)
  })

  it('apply 从标准输入读批量操作；--dry-run 不写文件', async () => {
    const ops = JSON.stringify([
      { op: 'replace', target: { quote: '市政厅', occurrence: 2 }, text: '议会' },
      { op: 'note', target: { section: '引言' }, issue: '太短', advice: '补一句' },
    ])
    const before = readFileSync(file, 'utf8')
    const dry = await cli(['apply', '稿.suixin.json', '-', '--dry-run'], ops)
    expect(dry.json).toMatchObject({ ok: true, written: false, dryRun: true })
    expect(readFileSync(file, 'utf8')).toBe(before)
    const real = await cli(['apply', '稿.suixin.json', '-'], ops)
    expect(real.json.written).toBe(true)
    expect(saved().suggestions.map((s: { kind: string }) => s.kind)).toEqual(['ai_diff', 'note'])
  })

  it('未授权时 --direct 被拒；结构操作在提建议模式下被拒', async () => {
    const a = await cli(['replace', '稿.suixin.json', '--quote', '被审计', '--text', 'x', '--direct'])
    expect(a.json.error.code).toBe('NOT_AUTHORIZED')
    const b = await cli(['run', '稿.suixin.json', 'rename_heading', '--heading', '尾声', '--text', '后记'])
    expect(b.json.error.code).toBe('NOT_AUTHORIZED')
  })

  it('作者授权后 --direct 直接修改，run 可调用任意操作', async () => {
    const data = saved()
    data.meta.agentAccess = 'direct'
    writeFileSync(file, JSON.stringify(data))
    const r = await cli(['run', '稿.suixin.json', 'rename_heading', '--heading', '尾声', '--text', '后记', '--direct', '--as', 'Kimi'])
    expect(r.json).toMatchObject({ ok: true, mode: 'direct', written: true })
    expect((await cli(['export', '稿.suixin.json'])).out).toContain('## 后记')
  })

  it('只能直接修改工程文件；Markdown 给出转换提示', async () => {
    const r = await cli(['replace', 'a.md', '--quote', '雨', '--text', 'x'])
    expect(r.json.error.code).toBe('UNSUPPORTED')
    expect(r.json.error.hint).toContain('suixin new')
  })

  it('ops 与 guide', async () => {
    const ops = await cli(['ops'])
    expect(ops.json.ops.map((o: { name: string }) => o.name)).toContain('replace')
    expect((await cli(['guide'])).out).toContain('--quote')
  })
})

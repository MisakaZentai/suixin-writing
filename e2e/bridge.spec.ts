/**
 * A3 实时桥：App 开着时，命令行 agent 的操作直接在作者眼前的文稿上执行，
 * 作者的决定实时回传。本机服务用测试替身（与 Rust 侧同一套 HTTP 约定），
 * 请求转进页面里真实的 handler；命令行是真实代码。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { runCli } from '../cli/suixin'
import { startFakeHub, type FakeHub } from './fakeHub'
import { openSample } from './helpers'
import type { AgentPresence, BridgeEvent, BridgeRequest, BridgeResponse } from '../src/bridge/protocol'

/** 开发模式下 src/bridge/connect.ts 挂在页面上的测试入口 */
declare global {
  interface Window {
    __suixinBridge?: {
      handle: (req: BridgeRequest) => Promise<BridgeResponse>
      setAgents: (agents: AgentPresence[]) => void
      connect: (publishName: string) => void
    }
  }
}

const SENTENCE = '未经登记的降水会被蒸发装置在半空拦截'

interface Session {
  hub: FakeHub
  cli: (args: string[], agent?: string) => Promise<{ code: number; json: any }>
  close: () => Promise<void>
}

async function connect(page: Page): Promise<Session> {
  const dir = mkdtempSync(path.join(tmpdir(), 'suixin-live-'))
  let hub: FakeHub | null = null
  await page.exposeFunction('__suixinPublish', (e: BridgeEvent) => hub?.publish(e))
  hub = await startFakeHub(dir, (req: BridgeRequest) => page.evaluate((r) => window.__suixinBridge!.handle(r), req))
  await page.evaluate(() => window.__suixinBridge!.connect('__suixinPublish'))
  const env = { SUIXIN_BRIDGE: hub.discoveryFile }
  return {
    hub,
    cli: async (args, agent = 'Codex') => {
      let out = ''
      const code = await runCli(args, {
        stdout: (t) => (out += t),
        stderr: () => {},
        readStdin: async () => '',
        env: { ...env, SUIXIN_AGENT: agent },
        cwd: dir,
      })
      return { code, json: JSON.parse(out) }
    },
    close: async () => {
      await hub?.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const paragraphs = (page: Page) => page.locator('.block-flow .block .block-text')

test('agent 的建议立即出现在作者眼前；作者接受后，等待中的 agent 马上知道', async ({ page }) => {
  await openSample(page)
  const s = await connect(page)
  try {
    const status = await s.cli(['status'])
    expect(status.json).toMatchObject({ ok: true, online: true, document: { title: '没有雨的城市' }, access: 'propose' })

    const r = await s.cli(['replace', '@', '--quote', SENTENCE, '--text', '没登记的雨会在半空被蒸发', '--why', '更短'])
    expect(r.json).toMatchObject({ ok: true, via: 'app', mode: 'propose', written: true })
    // 不用等轮询、不用重新打开：建议已经挂在段落上
    await expect(page.getByText('Codex 的修改待确认')).toHaveCount(1)

    const cursor = (await s.cli(['wait', '--timeout', '0.1'])).json.cursor
    const waiting = s.cli(['wait', '--since', String(cursor), '--types', 'suggestion.resolved', '--timeout', '10'])
    await page.getByText('Codex 的修改待确认').click()
    await page.locator('.diff-bar').getByRole('button', { name: /^接受/ }).click()
    await expect(paragraphs(page).first()).toContainText('没登记的雨会在半空被蒸发')

    const got = (await waiting).json
    expect(got.events).toHaveLength(1)
    expect(got.events[0]).toMatchObject({
      type: 'suggestion.resolved',
      state: 'accepted',
      author: 'Codex',
      text: '没登记的雨会在半空被蒸发',
      document: { title: '没有雨的城市' },
    })
  } finally {
    await s.close()
  }
})

test('交给 Agent：作者选中一段写下要求 → agent 接手、提建议、完成 → 待办里看到结果', async ({ page }) => {
  await openSample(page)
  const s = await connect(page)
  try {
    await page.evaluate(() => window.__suixinBridge!.setAgents([{ name: 'Codex', lastSeen: Date.now(), waiting: true }]))
    await expect(page.getByRole('button', { name: '在线的 Agent：Codex' })).toBeVisible()

    const cursor = (await s.cli(['wait', '--timeout', '0.1'])).json.cursor
    const waiting = s.cli(['wait', '--since', String(cursor), '--types', 'task.created', '--timeout', '10'])
    await paragraphs(page).nth(1).click()
    await page.keyboard.press('Space')
    await page.getByLabel('给 AI 的要求').fill('把经济学家那句改得更好懂')
    await page.getByRole('button', { name: '交给 Agent' }).click()
    await expect(page.getByText('已交给 Agent（Codex 在线）')).toBeVisible()
    const created = (await waiting).json.events[0]
    expect(created).toMatchObject({ type: 'task.created', task: { instruction: '把经济学家那句改得更好懂' } })
    expect(created.task.quote).toContain('经济学家说')

    const listed = (await s.cli(['tasks', '@'])).json
    expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true })
    expect(listed.results[0].tasks).toHaveLength(1)
    const task = listed.results[0].tasks[0]
    expect(task).toMatchObject({ state: 'open', section: '水的经济学' })

    await page.getByRole('button', { name: /^待办/ }).click()
    const card = page.getByLabel('任务：把经济学家那句改得更好懂')
    await expect(card).toContainText('等待 Agent 接手')
    expect((await s.cli(['claim', '@', task.id])).json.ok).toBe(true)
    await expect(card).toContainText('Codex 处理中')

    const quote = '一个城市的通胀水平，取决于它上个季度的蒸发量'
    expect((await s.cli(['replace', '@', '--quote', quote, '--text', '城里物价涨多少，看上个季度蒸发了多少水'])).json.ok).toBe(true)
    expect((await s.cli(['done', '@', task.id, '--summary', '改了一句，见待办'])).json.ok).toBe(true)
    await expect(card).toContainText('Codex 已完成')
    await expect(card).toContainText('说明：改了一句，见待办')
    await expect(page.getByRole('complementary', { name: '待办' }).getByText('Codex')).not.toHaveCount(0)
  } finally {
    await s.close()
  }
})

test('在线授权：拒绝则 --direct 仍被拒；允许后直接修改生效', async ({ page }) => {
  await openSample(page)
  const s = await connect(page)
  try {
    const dialog = page.getByRole('alertdialog', { name: '授权请求' })
    const denied = s.cli(['request-access', '--why', '要把尾声挪到前面'])
    await expect(dialog).toContainText('Codex')
    await expect(dialog).toContainText('要把尾声挪到前面')
    await dialog.getByRole('button', { name: '拒绝' }).click()
    expect((await denied).code).toBe(1)
    const refused = await s.cli(['replace', '@', '--quote', SENTENCE, '--text', 'x', '--direct'])
    expect(refused.json.error.code).toBe('NOT_AUTHORIZED')

    const allowed = s.cli(['request-access', '--why', '要把尾声挪到前面'])
    await dialog.getByRole('button', { name: '允许直接修改' }).click()
    expect((await allowed).json).toMatchObject({ ok: true, granted: true })
    const r = await s.cli(['run', '@', 'move_section', '--heading', '尾声', '--to', '引言', '--position', 'before', '--direct'])
    expect(r.json).toMatchObject({ ok: true, mode: 'direct', via: 'app' })
    // 整节（含正文）移到了最前
    await expect(paragraphs(page).first()).toContainText('昨天深夜')
  } finally {
    await s.close()
  }
})

test('agent 插图：对照里看到的是图片，接受后进入正文；agent 能把图取出来看', async ({ page }) => {
  await openSample(page)
  const s = await connect(page)
  try {
    // 标准的 1×1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    const dir = path.dirname(s.hub.discoveryFile)
    writeFileSync(path.join(dir, 'rain.png'), png)
    const r = await s.cli(['image', 'add', '@', 'rain.png', '--after-section', '引言', '--caption', '城里唯一一张雨的照片', '--why', '配图'])
    expect(r.json).toMatchObject({ ok: true, via: 'app', mode: 'propose', image: { width: 1, height: 1 } })

    await page.getByText('Codex 想在下面插入图片，点击查看').click()
    await expect(page.locator('.insertion-label')).toHaveText('Codex 插入的图片')
    const figure = page.locator('.diff-view .block-figure')
    await expect(figure.locator('figcaption')).toHaveText('城里唯一一张雨的照片')
    await expect.poll(() => figure.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
    await page.locator('.diff-bar').getByRole('button', { name: /^接受/ }).click()
    await expect(page.locator('.block-flow .block-figure figcaption')).toHaveText('城里唯一一张雨的照片')

    const list = (await s.cli(['images', '@'])).json.images
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ caption: '城里唯一一张雨的照片', exists: true, width: 1, height: 1 })
    const shown = (await s.cli(['image', 'show', '@', '--block', list[0].id, '-o', 'seen.png'])).json
    expect(readFileSync(shown.path)).toEqual(png)
  } finally {
    await s.close()
  }
})

test('agent 读得到作者的选区，并能直接用它给出的定位', async ({ page }) => {
  await openSample(page)
  const s = await connect(page)
  try {
    await paragraphs(page).nth(2).click()
    await expect
      .poll(async () => (await s.cli(['selection'])).json.selection?.section)
      .toBe('消失的职业')
    const sel = (await s.cli(['selection'])).json.selection
    expect(sel.text).toContain('气象预报员')
    const r = await s.cli(['note', '@', '--block', sel.target.block, '--issue', '结尾太突然', '--advice', '补一句过渡'])
    expect(r.json.ok).toBe(true)
    await expect(page.getByText('Codex')).not.toHaveCount(0)
  } finally {
    await s.close()
  }
})

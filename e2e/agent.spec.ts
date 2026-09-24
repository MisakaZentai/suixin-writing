/**
 * A1：命令行 agent 写入署名建议 → 在 App 里打开 → 看到署名与理由 → 整组接受；
 * 以及作者在「Agent 访问」里授权直接修改。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { runCli } from '../cli/suixin'
import { openSample } from './helpers'

const MD = '# 城市\n\n## 引言\n\n雨是一种被审计的液体。市政厅批准每一滴水。\n\n## 尾声\n\n市政厅没有解释。\n'

async function cli(dir: string, args: string[], stdin = '') {
  let out = ''
  const code = await runCli(args, {
    stdout: (t) => (out += t),
    stderr: () => {},
    readStdin: async () => stdin,
    env: { SUIXIN_AGENT: 'Codex' },
    cwd: dir,
  })
  return { code, json: JSON.parse(out) }
}

/** 通过拖放把工程文件打开到 App */
async function dropFile(page: Page, name: string, text: string) {
  await page.evaluate(
    ([name, text]) => {
      const dt = new DataTransfer()
      dt.items.add(new File([text], name, { type: 'application/json' }))
      const target = document.querySelector('.app') as HTMLElement
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    },
    [name, text]
  )
}

test('agent 用命令行提的一组修改：署名显示，整组接受后写入正文', async ({ page }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'suixin-e2e-'))
  try {
    writeFileSync(path.join(dir, 'a.md'), MD)
    expect((await cli(dir, ['new', '稿.suixin.json', '--from', 'a.md'])).code).toBe(0)
    const ops = JSON.stringify([
      { op: 'replace', target: { quote: '被审计' }, text: '要登记', why: '更口语' },
      { op: 'replace', target: { quote: '没有解释' }, text: '从不解释', why: '语气更硬' },
    ])
    const r = await cli(dir, ['apply', '稿.suixin.json', '-'], ops)
    expect(r.json).toMatchObject({ ok: true, mode: 'propose', written: true })

    await page.goto('/')
    await dropFile(page, '稿.suixin.json', readFileSync(path.join(dir, '稿.suixin.json'), 'utf8'))
    // 正文未变，两段都挂着 Codex 的待确认修改
    await expect(page.locator('.block-flow .block-text').first()).toHaveText('雨是一种被审计的液体。市政厅批准每一滴水。')
    await expect(page.getByText('Codex 的修改待确认')).toHaveCount(2)

    await page.getByText('Codex 的修改待确认').first().click()
    await expect(page.locator('.diff-instruction')).toContainText('Codex')
    await expect(page.locator('.diff-instruction')).toContainText('更口语')
    await expect(page.getByRole('button', { name: '再来一版' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '待办 2 项' }).click()
    const panel = page.getByRole('complementary', { name: '待办' })
    const group = panel.getByRole('region', { name: 'Codex 的一组修改' })
    await expect(group).toContainText('2 处修改')
    await group.getByRole('button', { name: '整组接受' }).click()
    await expect(page.getByText('已接受 2 处修改')).toBeVisible()
    await expect(page.locator('.block-flow .block-text')).toHaveText([
      '雨是一种要登记的液体。市政厅批准每一滴水。',
      '市政厅从不解释。',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Agent 访问：直接修改需作者二次确认，可随时收回；权限随工程文件保存', async ({ page }) => {
  await openSample(page)
  await page.locator('.toolbar').getByRole('button', { name: 'AI', exact: true }).click()
  await page.getByRole('button', { name: 'Agent 访问…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Agent 访问' })
  await expect(dialog.getByRole('radio', { name: /只能提建议/ })).toHaveAttribute('aria-checked', 'true')

  await dialog.getByRole('radio', { name: /允许直接修改/ }).click()
  // 未确认前权限不变
  await expect(dialog.getByRole('radio', { name: /只能提建议/ })).toHaveAttribute('aria-checked', 'true')
  await dialog.getByRole('button', { name: '取消' }).click()
  await dialog.getByRole('radio', { name: /允许直接修改/ }).click()
  await dialog.getByRole('button', { name: '确认授权' }).click()
  await expect(dialog.getByRole('radio', { name: /允许直接修改/ })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+Shift+s')])
  const json = JSON.parse(readFileSync((await download.path())!, 'utf8'))
  expect(json.meta.agentAccess).toBe('direct')

  // 收回
  await page.locator('.toolbar').getByRole('button', { name: 'AI', exact: true }).click()
  await page.getByRole('button', { name: 'Agent 访问…' }).click()
  await dialog.getByRole('radio', { name: /只能提建议/ }).click()
  await expect(page.getByText('已收回直接修改权限')).toBeVisible()
})

test('权限只在 App 里给：未授权时 agent 的 --direct 被拒，文件不变', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'suixin-e2e-'))
  try {
    writeFileSync(path.join(dir, 'a.md'), MD)
    await cli(dir, ['new', '稿.suixin.json', '--from', 'a.md'])
    const before = readFileSync(path.join(dir, '稿.suixin.json'), 'utf8')
    const r = await cli(dir, ['replace', '稿.suixin.json', '--quote', '被审计', '--text', 'x', '--direct'])
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('NOT_AUTHORIZED')
    expect(r.json.error.hint).toContain('Agent 访问')
    expect(readFileSync(path.join(dir, '稿.suixin.json'), 'utf8')).toBe(before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

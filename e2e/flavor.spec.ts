/**
 * AI 味：面板与正文标注、去 AI 味（定向改写 → 本地复检 → 不合格自动再改一版）、忽略。
 */
import { expect, test, type Page } from '@playwright/test'
import { mockAI, openSample, requestAt, type MockedRequest } from './helpers'

const KEY = () => localStorage.setItem('ai-writer:secret:apiKey:deepseek', 'sk-test')
const system = (req: MockedRequest) => req.body.messages?.find((m) => m.role === 'system')?.content ?? ''
const lastUser = (req: MockedRequest) => [...(req.body.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? ''

const HEAD = '在这座城市里，雨是一种被审计的液体。每一滴水的下落都要经过市政厅的批准，未经登记的降水会被蒸发装置在半空拦截。'
const WORSE = `${HEAD}市民们走路时总仰着头——不是在看天，是在查今天有没有人偷偷下了雨。`
const CLEAN = `${HEAD}市民们走路总仰着头，查的是今天有没有人偷偷下了雨。`

async function openFlavor(page: Page) {
  await page.getByRole('button', { name: 'AI', exact: true }).click()
  await page.getByRole('button', { name: '检查 AI 味' }).click()
  await expect(page.getByRole('complementary', { name: 'AI 味' })).toBeVisible()
}

test('检查 AI 味：面板给出指数与改法，正文标出命中', async ({ page }) => {
  await openSample(page)
  await expect(page.locator('.flavor-mark')).toHaveCount(0) // 面板没开时不标
  await openFlavor(page)
  const panel = page.getByRole('complementary', { name: 'AI 味' })
  await expect(panel.locator('.flavor-index')).toHaveText(/^\d+$/)
  await expect(panel.getByRole('button', { name: /不是…而是…/ })).toBeVisible()
  const mark = page.locator('.block-flow .flavor-mark.sev-high').first()
  await expect(mark).toBeVisible()
  expect(await page.locator('.block-flow .block').first().locator('.flavor-mark').allTextContents()).toEqual(['不是为了看天，而是'])
  // 选中这一段：面板列出这一段的命中与改法
  await page.locator('.block-flow .block').first().click()
  await expect(panel.locator('.flavor-active')).toContainText('「不是为了看天，而是」')
  await expect(panel.locator('.flavor-active')).toContainText('直接说肯定的那一半')
  // 规则展开看原因与依据
  await panel.getByRole('button', { name: /不是…而是…/ }).click()
  await expect(panel.locator('.flavor-rule-body')).toContainText('依据')
  await page.keyboard.press('Escape')
})

test('去 AI 味：带着命中清单改写；复检发现换汤不换药，自动再改一版', async ({ page }) => {
  await page.addInitScript(KEY)
  let n = 0
  const seen = await mockAI(page, () => (n++ === 0 ? WORSE : CLEAN))
  await openSample(page)
  await openFlavor(page)
  await page.locator('.block-flow .block').first().click()
  await page.locator('.flavor-active').getByRole('button', { name: '去 AI 味' }).click()

  const first = await requestAt(seen, 0)
  expect(system(first)).toContain('不要用一种套路替换另一种')
  expect(lastUser(first)).toContain('【要处理的 AI 腔】')
  expect(lastUser(first)).toContain('「不是为了看天，而是」——不是…而是…')
  expect(lastUser(first)).toContain('【作者自己写的段落（体会语感，不要照抄内容）】')

  // 第一版把"不是…而是"换成了"不是…，是"，还加了破折号：复检不通过，带着问题再改
  const second = await requestAt(seen, 1)
  expect(lastUser(second)).toContain('这一版还有问题')
  expect(lastUser(second)).toContain('「不是在看天，是」（不是…而是…）还在')
  expect(lastUser(second)).toContain('新增了「——」（破折号）')
  expect(second.body.messages?.some((m) => m.role === 'assistant' && m.content === WORSE)).toBe(true)

  // 两版都留作候选，默认显示第二版；确认条上是 AI 味的前后对比
  const diff = page.locator('.diff-view')
  await expect(diff.locator('.diff-candidates')).toContainText('2 / 2')
  await expect(diff.locator('.diff-flavor')).toContainText('去掉了不是…而是…')
  await expect(diff.locator('.diff-flavor')).not.toHaveClass(/worse/)
  // 切回第一版：确认条标红，指出换了说法仍是同一个套路
  await page.keyboard.press('ArrowLeft')
  await expect(diff.locator('.diff-flavor')).toHaveClass(/worse/)
  await expect(diff.locator('.diff-flavor')).toContainText('换了说法，仍是不是…而是…')
  await page.keyboard.press('ArrowRight')
  await diff.locator('.diff-bar').getByRole('button', { name: /^接受/ }).click()
  await expect(page.locator('.block-flow .block').first().locator('.block-text')).toHaveText(CLEAN)
  expect(seen).toHaveLength(2)
})

test('这处没问题：不再标出，可以全部恢复', async ({ page }) => {
  await openSample(page)
  await openFlavor(page)
  await page.locator('.block-flow .block').first().click()
  const panel = page.getByRole('complementary', { name: 'AI 味' })
  await panel.getByRole('button', { name: '这处没问题' }).click()
  await expect(page.locator('.block-flow .flavor-mark')).toHaveCount(0)
  await expect(panel).toContainText('没有发现明显的 AI 腔')
  await expect(panel).toContainText('已忽略 1 处')
  await panel.getByRole('button', { name: '全部恢复' }).click()
  await expect(page.locator('.block-flow .flavor-mark')).toHaveCount(1)
})

test('指令框里的「去 AI 味」：没有命中时就地告知，不发请求', async ({ page }) => {
  await page.addInitScript(KEY)
  const seen = await mockAI(page, () => 'x')
  await openSample(page)
  // 第二段没有命中
  await page.locator('.block-flow .block').nth(1).click()
  await page.keyboard.press(' ')
  await page.locator('.ai-prompt').getByRole('button', { name: '去 AI 味' }).click()
  await expect(page.getByText('这里没有发现明显的 AI 腔')).toBeVisible()
  expect(seen).toHaveLength(0)
})

test('建立我的基线：来源本身 AI 味重时先提醒；建好后按它计算', async ({ page }) => {
  await openSample(page)
  await openFlavor(page)
  const panel = page.getByRole('complementary', { name: 'AI 味' })
  await expect(panel).toContainText('相对内置的人类基线')
  await panel.getByRole('button', { name: '建立我的基线…' }).click()
  const dialog = page.getByRole('dialog', { name: '建立我的基线' })
  await dialog.getByRole('checkbox').first().check() // 文稿库里的示例文稿
  await dialog.getByRole('button', { name: '建立', exact: true }).click()
  // 示例文稿本身就有"不是…而是…"：提醒会把套路当成习惯，要再确认一次
  await expect(dialog.locator('.baseline-warning')).toContainText('AI 味指数')
  await dialog.getByRole('button', { name: '仍然建立' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(panel).toContainText('相对「我的文风」的基线')
  await expect(panel.getByRole('combobox', { name: '基线' })).toContainText('我的文风（')
  // 刷新后仍在（浏览器模式存在本机）
  await page.reload()
  await page.locator('.block-flow .block').first().waitFor()
  await openFlavor(page)
  await expect(page.getByRole('complementary', { name: 'AI 味' })).toContainText('相对「我的文风」的基线')
})

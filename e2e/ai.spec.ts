/**
 * 第 5 步回归：AI 的作用范围由选区决定；统一指令框；就地配置与就地报错。
 */
import { expect, test, type Page } from '@playwright/test'
import { mockAI, openSample, requestAt, type MockedRequest } from './helpers'

const KEY = () => localStorage.setItem('ai-writer:secret:apiKey:deepseek', 'sk-test')
const userMessage = (req: MockedRequest) => req.body.messages?.find((m) => m.role === 'user')?.content ?? ''
const paragraphs = (page: Page) => page.locator('.block-flow .block .block-text')

async function acceptAll(page: Page) {
  await page.locator('.diff-bar').getByRole('button', { name: /^接受/ }).click()
  await expect(page.locator('.diff-view')).toHaveCount(0, { timeout: 5000 })
}

test('划选段内一句话 → 只改这一句，前后原样保留', async ({ page }) => {
  await page.addInitScript(KEY)
  const seen = await mockAI(page, () => '每滴水落下前都要市政厅点头。')
  await openSample(page)
  const first = paragraphs(page).first()
  const original = (await first.textContent())!
  const sentence = '每一滴水的下落都要经过市政厅的批准，未经登记的降水会被蒸发装置在半空拦截。'
  const start = original.indexOf(sentence)
  await first.evaluate(
    (el, [s, e]) => {
      const node = el.firstChild as Text
      const range = document.createRange()
      range.setStart(node, s)
      range.setEnd(node, e)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
    },
    [start, start + sentence.length]
  )
  await page.getByRole('button', { name: /AI 改选中的文字/ }).click()
  await expect(page.locator('.ai-prompt-scope')).toContainText('选中的文字')
  await page.keyboard.press('Enter')
  expect(userMessage(await requestAt(seen))).toContain(`【待处理正文】（这是一段话中间的一部分`)
  expect(userMessage(await requestAt(seen)).split('【待处理正文】')[1]).toContain(sentence)
  await acceptAll(page)
  await expect(first).toHaveText(original.replace(sentence, '每滴水落下前都要市政厅点头。'))
})

test('Shift+↓ 选中两段 → 精简 → 合成一段', async ({ page }) => {
  await page.addInitScript(KEY)
  const seen = await mockAI(page, () => '水票是城里的第二种货币，黑市溢价三成，通胀随蒸发量涨落。')
  await page.goto('/')
  await page.getByRole('button', { name: '粘贴导入…' }).click()
  await page.getByLabel('要导入的内容').fill('# 测试\n\n城里流通两种货币。\n\n水票不记名、不挂失。\n\n最后一段。')
  await page.getByRole('button', { name: '导入为新文稿' }).click()
  await paragraphs(page).first().click()
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('.block.in-selection')).toHaveCount(2)
  await page.keyboard.press('Space')
  await expect(page.locator('.ai-prompt-scope')).toContainText('选中的 2 段')
  await page.locator('.ai-prompt').getByRole('button', { name: '精简' }).click()
  const msg = userMessage(await requestAt(seen))
  expect(msg).toContain('城里流通两种货币。\n\n水票不记名、不挂失。')
  expect(msg).toContain('【修改意见】精简表达')
  await acceptAll(page)
  await expect(paragraphs(page)).toHaveText([
    '水票是城里的第二种货币，黑市溢价三成，通胀随蒸发量涨落。',
    '最后一段。',
  ])
})

test('选区跨过标题时给出提示，不发请求', async ({ page }) => {
  await page.addInitScript(KEY)
  const seen = await mockAI(page, () => 'x')
  await openSample(page)
  await paragraphs(page).first().click()
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Space')
  await expect(page.getByText('选区跨越了章节标题，请分节处理')).toBeVisible()
  expect(seen).toHaveLength(0)
})

test('续写：在这一段后面新写一段', async ({ page }) => {
  await page.addInitScript(KEY)
  const seen = await mockAI(page, () => '后来，城里开始流行看云。')
  await openSample(page)
  const count = await paragraphs(page).count()
  await paragraphs(page).nth(2).click()
  await page.keyboard.press('Space')
  await page.locator('.ai-prompt').getByRole('button', { name: '续写' }).click()
  expect(userMessage(await requestAt(seen))).toContain('气象预报员是二十年前被裁撤的')
  await expect(page.locator('.insertion')).toBeVisible()
  await acceptAll(page)
  await expect(paragraphs(page)).toHaveCount(count + 1)
  await expect(paragraphs(page).nth(3)).toHaveText('后来，城里开始流行看云。')
})

test('没配 Key 时在指令框里就地配置，然后直接用', async ({ page }) => {
  await mockAI(page, () => '改好的一段。')
  await openSample(page)
  await paragraphs(page).first().click()
  await page.keyboard.press('Space')
  await expect(page.getByText('先接入一个 AI 服务')).toBeVisible()
  await expect(page.locator('.ai-prompt').getByRole('button', { name: '润色', exact: true })).toBeDisabled()
  await page.getByLabel('API Key', { exact: true }).fill('sk-new')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('先接入一个 AI 服务')).toHaveCount(0)
  await page.locator('.ai-prompt').getByRole('button', { name: '润色', exact: true }).click()
  await acceptAll(page)
  await expect(paragraphs(page).first()).toHaveText('改好的一段。')
})

test('请求失败：错误就地显示，重试即可', async ({ page }) => {
  await page.addInitScript(KEY)
  let calls = 0
  await page.route('**/chat/completions', async (route) => {
    calls++
    if (calls === 1) {
      await route.fulfill({ status: 500, body: '{"error":"server busy"}' })
      return
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: '重试成功的一段。' } }] })}\n\ndata: [DONE]\n\n`,
    })
  })
  await openSample(page)
  await paragraphs(page).first().click()
  await page.keyboard.press('Space')
  await page.keyboard.press('Enter')
  const error = page.locator('.ai-error')
  await expect(error).toContainText('API 返回 500')
  await error.getByRole('button', { name: '重试' }).click()
  await acceptAll(page)
  await expect(paragraphs(page).first()).toHaveText('重试成功的一段。')
})

test('写作设定随请求发送', async ({ page }) => {
  await page.addInitScript(KEY)
  const seen = await mockAI(page, () => '新的一段。')
  await openSample(page)
  await page.getByRole('button', { name: '文件' }).click()
  await page.getByRole('button', { name: '写作设定…' }).click()
  await page.getByRole('textbox', { name: '写作设定' }).fill('读者是中学生，语气活泼。')
  await page.getByRole('button', { name: '完成' }).click()
  await paragraphs(page).first().click()
  await page.keyboard.press('Space')
  await page.keyboard.press('Enter')
  await expect(page.locator('.diff-view')).toBeVisible()
  expect(userMessage(await requestAt(seen))).toContain('【写作设定】读者是中学生，语气活泼。')
})

test('在标题上唤起 AI：作用于整节正文', async ({ page }) => {
  await page.addInitScript(KEY)
  const seen = await mockAI(page, () => '新的第一段。\n\n新的第二段。')
  await openSample(page)
  await page.locator('.heading-block', { hasText: '尾声' }).click()
  await page.keyboard.press('Space')
  await expect(page.locator('.ai-prompt-scope')).toContainText('本节「尾声」（1 段）')
  await page.keyboard.type('分成两段')
  await page.keyboard.press('Enter')
  expect(userMessage(await requestAt(seen))).toContain('【修改意见】分成两段')
  await acceptAll(page)
  await expect(paragraphs(page).last()).toHaveText('新的第二段。')
})

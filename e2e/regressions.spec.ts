/**
 * 代码审查发现的问题的回归测试：草稿丢失、标题重置、并发生成、撤销后对照卡住、草稿未自动保存。
 */
import { expect, test, type Page } from '@playwright/test'
import { openSample, sseBody } from './helpers'

const KEY = () => localStorage.setItem('ai-writer:secret:apiKey:deepseek', 'sk-test')

/** 慢速 AI：每个请求等 delay 毫秒才返回 */
async function slowAI(page: Page, reply: string, delay = 1200) {
  let calls = 0
  await page.route('**/chat/completions', async (route) => {
    calls++
    await new Promise((r) => setTimeout(r, delay))
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: sseBody(reply),
    })
  })
  return () => calls
}

const paragraphs = (page: Page) => page.locator('.block-flow .block .block-text')

test('AI 结果回来时，另一段正在写的草稿不会丢', async ({ page }) => {
  await page.addInitScript(KEY)
  await slowAI(page, '改好的第一段。')
  await openSample(page)
  await paragraphs(page).first().click()
  await page.keyboard.press('Space')
  await page.keyboard.press('Enter')
  await expect(page.locator('.stream-indicator')).toBeVisible()
  await paragraphs(page).last().dblclick()
  await page.keyboard.press('End')
  await page.keyboard.type('我新写的一句话。')
  await expect(page.locator('.diff-view')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.block-flow .block').last()).toContainText('我新写的一句话。')
})

test('正在等 AI 结果的段落不能同时编辑', async ({ page }) => {
  await page.addInitScript(KEY)
  await slowAI(page, '改好的第一段。')
  await openSample(page)
  await paragraphs(page).first().click()
  await page.keyboard.press('Space')
  await page.keyboard.press('Enter')
  await expect(page.locator('.stream-indicator')).toBeVisible()
  // 从下面的标题按 ↑ 想把编辑移进正在生成的段落
  await page.locator('.heading-block', { hasText: '水的经济学' }).dblclick()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowUp')
  await expect(page.getByText('这一段正在等 AI 的结果')).toBeVisible()
  await expect(page.locator('textarea.block-edit')).toHaveCount(0)
  await expect(page.locator('.heading-input')).toBeFocused()
})

test('编辑标题时双击选词，不会把标题重置', async ({ page }) => {
  await openSample(page)
  const heading = page.locator('.heading-block', { hasText: '水的经济学' })
  await heading.dblclick()
  const input = page.locator('.heading-input')
  await page.keyboard.press('End')
  await page.keyboard.type('（修订）')
  await input.dblclick()
  await expect(input).toHaveValue('水的经济学（修订）')
})

test('生成中再点"扩写本节"：提示已有任务，不发第二个请求', async ({ page }) => {
  await page.addInitScript(KEY)
  const calls = await slowAI(page, '改好的第一段。', 1500)
  await openSample(page)
  await paragraphs(page).first().click()
  await page.keyboard.press('Space')
  await page.keyboard.press('Enter')
  await expect(page.locator('.stream-indicator')).toBeVisible()
  await page.locator('.outline-row', { hasText: '尾声' }).hover()
  await page.locator('.outline-row', { hasText: '尾声' }).getByTitle('AI 扩写这一节').click()
  await expect(page.getByText('已有生成任务进行中')).toBeVisible()
  await expect(page.locator('.diff-view')).toBeVisible({ timeout: 5000 })
  expect(calls()).toBe(1)
})

test('对照打开时按 Ctrl+Z：对照关闭，被收起的段落回来', async ({ page }) => {
  await page.addInitScript(KEY)
  await slowAI(page, '合成的一段。', 10)
  await page.goto('/')
  await page.getByRole('button', { name: '粘贴导入…' }).click()
  await page.getByLabel('要导入的内容').fill('# 测试\n\n第一段文字。\n\n第二段文字。')
  await page.getByRole('button', { name: '导入为新文稿' }).click()
  await paragraphs(page).first().click()
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Space')
  await page.keyboard.press('Enter')
  await expect(page.locator('.diff-view')).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(page.locator('.diff-view')).toHaveCount(0)
  await expect(paragraphs(page)).toHaveText(['第一段文字。', '第二段文字。'])
})

test('正在编辑的段落也会自动保存，不是只存在内存里', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '从空白开始写' }).click()
  await page.keyboard.type('还没按 Esc 的一段话')
  await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible({ timeout: 4000 })
  const stored = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const req = indexedDB.open('suixin-library')
        req.onsuccess = () => {
          const tx = req.result.transaction('contents', 'readonly')
          const all = tx.objectStore('contents').getAll()
          all.onsuccess = () => resolve(String(all.result[0] ?? ''))
        }
      })
  )
  expect(stored).toContain('还没按 Esc 的一段话')
})

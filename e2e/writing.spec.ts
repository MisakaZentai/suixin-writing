/**
 * 第 3 步回归：能真正"写"——空白文稿、回车分段、退格合并、跨段移动、双击落点。
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { openSample } from './helpers'

async function exportMd(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Control+Shift+e'),
  ])
  return readFileSync((await download.path())!, 'utf8')
}

async function startBlank(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: '从空白开始写' }).click()
  await expect(page.locator('textarea.block-edit')).toBeFocused()
}

const paragraphs = (page: Page) => page.locator('.block-flow .block .block-text')

test('从空白开始写：回车分段，Esc 完成', async ({ page }) => {
  await startBlank(page)
  await page.keyboard.type('第一段。')
  await page.keyboard.press('Enter')
  await page.keyboard.type('第二段。')
  await page.keyboard.press('Escape')
  await expect(page.locator('textarea.block-edit')).toHaveCount(0)
  await expect(paragraphs(page)).toHaveText(['第一段。', '第二段。'])
  expect(await exportMd(page)).toBe('# 未命名文稿\n\n第一段。\n\n第二段。\n')
})

test('在段中按回车拆成两段，段首退格再合回来', async ({ page }) => {
  await startBlank(page)
  await page.keyboard.type('甲乙')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(paragraphs(page)).toHaveText(['甲', '乙'])

  await paragraphs(page).nth(1).dblclick()
  await page.keyboard.press('Home')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('X')
  await page.keyboard.press('Escape')
  await expect(paragraphs(page)).toHaveText(['甲X乙'])
})

test('段首按 ↑ 移到上一段末尾继续写', async ({ page }) => {
  await startBlank(page)
  await page.keyboard.type('上')
  await page.keyboard.press('Enter')
  await page.keyboard.type('下')
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('！')
  await page.keyboard.press('Escape')
  await expect(paragraphs(page)).toHaveText(['上！', '下'])
})

test('清空的段落自动移除', async ({ page }) => {
  await startBlank(page)
  await page.keyboard.type('留下')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(paragraphs(page)).toHaveText(['留下'])
})

test('"## " 开头按回车变成标题，并在其下继续写正文', async ({ page }) => {
  await startBlank(page)
  await page.keyboard.type('## 第一章')
  await page.keyboard.press('Enter')
  await page.keyboard.type('正文')
  await page.keyboard.press('Escape')
  await expect(page.locator('.block-flow h2')).toHaveText(['第一章'])
  expect(await exportMd(page)).toBe('# 未命名文稿\n\n## 第一章\n\n正文\n')
})

test('双击段落，光标落在点击处', async ({ page }) => {
  await openSample(page)
  const text = paragraphs(page).first()
  const point = await text.evaluate((el) => {
    const node = el.firstChild as Text
    const range = document.createRange()
    range.setStart(node, 10)
    range.setEnd(node, 11)
    const r = range.getBoundingClientRect()
    return { x: r.left + 2, y: r.top + r.height / 2 }
  })
  await page.mouse.dblclick(point.x, point.y)
  const editor = page.locator('textarea.block-edit')
  await expect(editor).toBeFocused()
  const caret = await editor.evaluate((el: HTMLTextAreaElement) => el.selectionStart)
  expect(caret).toBeGreaterThanOrEqual(9)
  expect(caret).toBeLessThanOrEqual(11)
})

test('点击空白处即完成编辑并保存', async ({ page }) => {
  await openSample(page)
  const first = page.locator('.block-flow .block').first()
  await first.click()
  await page.keyboard.press('e')
  await page.keyboard.type('（新增）')
  await page.mouse.click(1380, 700)
  await expect(page.locator('textarea.block-edit')).toHaveCount(0)
  await expect(first).toContainText('（新增）')
})

test('文末"继续写…"新起一段', async ({ page }) => {
  await openSample(page)
  await page.getByRole('button', { name: '继续写…' }).click()
  await page.keyboard.type('新的结尾。')
  await page.keyboard.press('Escape')
  await expect(paragraphs(page).last()).toHaveText('新的结尾。')
})

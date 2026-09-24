/**
 * 第 2 步回归：段落是持久单位、标题在正文里、大纲由标题生成。
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { mockAI, openSample } from './helpers'
import { SAMPLE_TEXT } from '../src/lib/sample'

async function downloadText(page: Page, shortcut: string): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press(shortcut)])
  return readFileSync((await download.path())!, 'utf8')
}

test('示例文稿：标题在正文里，大纲是 4 个平级章节，没有粒度开关', async ({ page }) => {
  await openSample(page)
  await expect(page.locator('.block-flow h2')).toHaveText(['引言', '水的经济学', '消失的职业', '尾声'])
  await expect(page.locator('.outline-row')).toHaveCount(4)
  await expect(page.locator('.outline-row .chevron:not(.leaf)')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: '句子' })).toHaveCount(0)
})

test('不做任何修改，导出的 Markdown 与导入的原文逐字一致', async ({ page }) => {
  await openSample(page)
  expect(await downloadText(page, 'Control+Shift+e')).toBe(SAMPLE_TEXT)
})

test('回退到导入版本只恢复这一段，其他段落不受影响', async ({ page }) => {
  await openSample(page)
  const paragraphs = page.locator('.block-flow .block')
  const count = await paragraphs.count()
  const first = paragraphs.first()
  const original = (await first.locator('.block-text').textContent())!
  await first.click()
  await page.keyboard.press('e')
  await page.keyboard.press('End')
  await page.keyboard.type('（补一句）')
  await page.keyboard.press('Control+Enter')
  await expect(first).toContainText('（补一句）')

  await first.click()
  await page.getByTitle('版本历史').click()
  await page.locator('.version-item').last().click()
  await expect(first.locator('.block-text')).toHaveText(original)
  await expect(paragraphs).toHaveCount(count)
})

test('扩写一节：整节正文被替换，不会重复出现', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ai-writer:secret:apiKey:deepseek', 'sk-test'))
  await mockAI(page, () => '气象预报员是二十年前被裁撤的。\n\n他们的最后一任局长说：我们是预测对了太多次。\n\n如今看云需要许可证。')
  await openSample(page)
  await page.locator('.heading-block', { hasText: '消失的职业' }).click({ button: 'right' })
  await page.locator('.context-menu').getByRole('button', { name: 'AI 扩写本节' }).click()
  await page.locator('.diff-bar').getByRole('button', { name: /^接受/ }).click()
  await expect(page.locator('.diff-view')).toHaveCount(0, { timeout: 5000 })
  const md = await downloadText(page, 'Control+Shift+e')
  const section = md.split('## 消失的职业\n\n')[1].split('\n\n## ')[0]
  expect(section).toBe(
    '气象预报员是二十年前被裁撤的。\n\n他们的最后一任局长说：我们是预测对了太多次。\n\n如今看云需要许可证。'
  )
})

test('段落开头输入 "## " 转为标题，并出现在大纲里', async ({ page }) => {
  await openSample(page)
  const last = page.locator('.block-flow .block').last()
  await last.click({ button: 'right' })
  await page.locator('.context-menu').getByRole('button', { name: '在下方插入段落' }).click()
  await page.keyboard.type('## 后记')
  await page.keyboard.press('Control+Enter')
  await expect(page.locator('.block-flow h2').last()).toHaveText('后记')
  await expect(page.locator('.outline-title').last()).toHaveText('后记')
})

test('旧版工程文件自动迁移', async ({ page }) => {
  await page.goto('/')
  const v1 = {
    schema: 'ai-writer/project@1',
    meta: { title: '旧文稿', createdAt: '', updatedAt: '', language: 'zh' },
    settings: { model: 'x', baseURL: 'x', temperature: 0.7 },
    outline: [{ id: 'on_1', title: '第一章', children: [] }],
    blocks: [
      { id: 'b1', outlineNodeId: 'on_1', order: 0, text: '第一句。', status: 'clean', versions: [], paragraphId: 'p1' },
      { id: 'b2', outlineNodeId: 'on_1', order: 1, text: '第二句。', status: 'clean', versions: [], paragraphId: 'p1' },
    ],
    suggestions: [],
  }
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /打开文件/ }).click()
  await (await chooser).setFiles({
    name: '旧文稿.aiwriter.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(v1)),
  })
  await expect(page.locator('.block-flow h2')).toHaveText(['第一章'])
  await expect(page.locator('.block-flow .block .block-text')).toHaveText(['第一句。第二句。'])
})

test('5 万字文稿：点选一段的响应在 300ms 内', async ({ page }) => {
  await page.goto('/')
  const para = '市民们习惯了仰着头走路，不是为了看天，而是为了确认今天有没有谁偷偷下了雨。城里流通两种货币：一种是信用点，另一种是水票。'
  let big = ''
  let section = 0
  while (big.length < 50_000) {
    if (big.length % 3000 < 130) big += `## 第${++section}节\n\n`
    big += `${para}${para}\n\n`
  }
  await page.evaluate((text) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }))
  }, big)
  const blocks = page.locator('.block-flow .block')
  await blocks.first().waitFor()
  const target = blocks.nth(40)
  await target.scrollIntoViewIfNeeded()
  const elapsed = await target.evaluate(async (el) => {
    const t0 = performance.now()
    ;(el as HTMLElement).click()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return performance.now() - t0
  })
  await expect(target).toHaveClass(/active/)
  expect(elapsed).toBeLessThan(300)
})

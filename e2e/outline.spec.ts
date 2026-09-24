/**
 * 第 7 步回归：大纲即结构——拖拽移动整节、升降级、AI 划分章节（先预览）、检查全文。
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { mockAI, openSample, requestAt, type MockedRequest } from './helpers'

const row = (page: Page, title: string) => page.locator('.outline-row', { hasText: title })

async function exportMd(page: Page): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+Shift+e')])
  return readFileSync((await download.path())!, 'utf8')
}

const headingsOf = (md: string) => md.split('\n').filter((l) => l.startsWith('#'))

test('拖拽"尾声"到"引言"上沿：整节（含正文）移到最前', async ({ page }) => {
  await openSample(page)
  await row(page, '尾声').dragTo(row(page, '引言'), { targetPosition: { x: 40, y: 2 } })
  await expect(page.locator('.block-flow h2')).toHaveText(['尾声', '引言', '水的经济学', '消失的职业'])
  const md = await exportMd(page)
  expect(md.indexOf('## 尾声\n\n昨天深夜')).toBeGreaterThan(0)
  expect(md.indexOf('## 尾声')).toBeLessThan(md.indexOf('## 引言'))
})

test('拖到另一节中间：成为它的小节，层级随之调整', async ({ page }) => {
  await openSample(page)
  await row(page, '消失的职业').dragTo(row(page, '水的经济学'), { targetPosition: { x: 40, y: 14 } })
  expect(headingsOf(await exportMd(page))).toEqual([
    '# 没有雨的城市',
    '## 引言',
    '## 水的经济学',
    '### 消失的职业',
    '## 尾声',
  ])
  await expect(row(page, '消失的职业')).toHaveCount(1)
})

test('右键降一级：整节变成上一节的小节', async ({ page }) => {
  await openSample(page)
  await row(page, '尾声').click({ button: 'right' })
  await page.locator('.context-menu').getByRole('button', { name: '降一级（整节）' }).click()
  await expect(page.locator('.block-flow h3')).toHaveText(['尾声'])
})

test('AI 划分章节：先看提案，勾选、改名后再插入', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ai-writer:secret:apiKey:deepseek', 'sk-test'))
  await mockAI(page, () =>
    JSON.stringify({
      title: '城市笔记',
      headings: [
        { before: 1, level: 2, title: '开头' },
        { before: 3, level: 2, title: '后来' },
      ],
    })
  )
  await page.goto('/')
  await page.getByRole('button', { name: '粘贴导入…' }).click()
  await page.getByLabel('要导入的内容').fill('第一段。\n\n第二段。\n\n第三段。\n\n第四段。')
  await page.getByRole('button', { name: '导入为新文稿' }).click()
  await page.getByRole('button', { name: 'AI', exact: true }).click()
  await page.locator('.file-menu').getByRole('button', { name: '划分章节' }).click()
  const modal = page.getByRole('dialog', { name: 'AI 建议的章节' })
  await expect(modal.getByLabel('标题')).toHaveCount(2)
  await expect(page.locator('.block-flow h2')).toHaveCount(0) // 确认前不改正文
  await modal.getByLabel('插入「开头」').uncheck()
  await modal.getByLabel('标题').nth(1).fill('转折')
  await modal.getByRole('button', { name: '插入 1 个标题' }).click()
  await expect(page.locator('.block-flow h2')).toHaveText(['转折'])
  const md = await exportMd(page)
  expect(md).toBe('# 城市笔记\n\n第一段。\n\n第二段。\n\n## 转折\n\n第三段。\n\n第四段。\n')
})

test('检查全文：建议进入待办，"按建议修改"带着建议打开 AI 指令框', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ai-writer:secret:apiKey:deepseek', 'sk-test'))
  const seen = await mockAI(page, () =>
    JSON.stringify({ issues: [{ index: 2, issue: '与上一段重复', advice: '删去与上一段重复的货币介绍' }] })
  )
  await openSample(page)
  await page.getByRole('button', { name: 'AI', exact: true }).click()
  await page.getByRole('button', { name: '检查全文' }).click()
  expect(((await requestAt(seen)).body.messages ?? [])[1].content).toContain('（水的经济学）')
  const panel = page.getByRole('complementary', { name: '待办' })
  await expect(panel.locator('.suggestion-card')).toHaveCount(1)
  await expect(panel).toContainText('与上一段重复')
  await panel.getByRole('button', { name: '按建议修改' }).click()
  await expect(page.locator('.ai-prompt-input')).toHaveValue('删去与上一段重复的货币介绍')
})

test('右键"AI 精简本节"：整节正文作为范围发送', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ai-writer:secret:apiKey:deepseek', 'sk-test'))
  let request: MockedRequest | null = null
  await mockAI(page, (req) => {
    request = req
    return '精简后的尾声。'
  })
  await openSample(page)
  await row(page, '尾声').click({ button: 'right' })
  await page.locator('.context-menu').getByRole('button', { name: 'AI 精简本节' }).click()
  await expect(page.locator('.diff-view')).toBeVisible()
  const content = (request!.body.messages ?? [])[1].content
  expect(content).toContain('【待处理正文】\n昨天深夜')
  expect(content).toContain('【修改意见】精简这一节')
})

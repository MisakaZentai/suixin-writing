/**
 * 第 4 步回归：文稿自动保存、导入不替换、最近文稿、整窗拖放、Ctrl+S 不再每次下载。
 */
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { openSample } from './helpers'

test('新写的文稿自动保存，刷新后直接回到这篇', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '从空白开始写' }).click()
  await page.keyboard.type('不会丢的一段。')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible()
  await page.reload()
  await expect(page.locator('.block-flow .block-text')).toHaveText(['不会丢的一段。'])
})

test('导入不会替换当前文稿，两篇都在最近文稿里', async ({ page }) => {
  await openSample(page)
  await page.getByRole('button', { name: '文件' }).click()
  await page.getByRole('button', { name: '粘贴导入…' }).click()
  await page.getByLabel('要导入的内容').fill('# 第二篇\n\n另一篇的正文。')
  await page.getByRole('button', { name: '导入为新文稿' }).click()
  await expect(page.locator('.block-flow .block-text')).toHaveText(['另一篇的正文。'])

  await page.getByRole('button', { name: '随心写作' }).click()
  const names = page.locator('.recent-name')
  await expect(names).toHaveText(['第二篇', '没有雨的城市'])
  await names.nth(1).click()
  await expect(page.locator('.block-flow h2').first()).toHaveText('引言')
})

test('Ctrl+S 保存到文稿库，不触发下载；另存为才下载工程文件', async ({ page }) => {
  await openSample(page)
  let downloads = 0
  page.on('download', () => downloads++)
  await page.keyboard.press('Control+s')
  await expect(page.getByText(/已保存到本机文稿库/)).toBeVisible()
  expect(downloads).toBe(0)
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+Shift+s')])
  // 注：云端无头 Chromium 会把中文下载文件名替换成 "download"，这里只校验内容
  const json = JSON.parse(readFileSync((await download.path())!, 'utf8'))
  expect(json.schema).toBe('suixin/project@2')
  expect(json.meta.title).toBe('没有雨的城市')
})

test('把文件拖进窗口任意位置：打开为新文稿，页面不会跳走', async ({ page }) => {
  await openSample(page)
  const url = page.url()
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['# 拖进来的\n\n拖放的正文。'], '拖进来的.md', { type: 'text/markdown' }))
    const target = document.querySelector('.block-flow') as HTMLElement
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.block-flow .block-text')).toHaveText(['拖放的正文。'])
  expect(page.url()).toBe(url)
  await expect(page.locator('.toolbar-doc-title')).toHaveValue('拖进来的')
})

test('删除最近文稿需要确认', async ({ page }) => {
  await openSample(page)
  await page.getByRole('button', { name: '随心写作' }).click()
  const row = page.locator('.recent-row').first()
  await row.hover()
  await row.getByRole('button', { name: /删除/ }).click()
  await row.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.locator('.recent-row')).toHaveCount(0)
})

test('旧版"崩溃恢复"里的文稿迁移进最近文稿', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem(
      'ai-writer:recovery',
      JSON.stringify({
        schema: 'ai-writer/project@1',
        meta: { title: '恢复的旧稿', createdAt: '', updatedAt: '', language: 'zh' },
        outline: [],
        blocks: [{ id: 'b1', outlineNodeId: null, order: 0, text: '旧稿正文。', status: 'clean', versions: [], paragraphId: 'p1' }],
        suggestions: [],
      })
    )
  })
  await page.goto('/')
  await expect(page.locator('.recent-name')).toHaveText(['恢复的旧稿'])
  await page.locator('.recent-name').click()
  await expect(page.locator('.block-flow .block-text')).toHaveText(['旧稿正文。'])
})

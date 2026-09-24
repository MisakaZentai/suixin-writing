/**
 * A4.1 图片：粘贴 / 拖入插图、写图注、导出 Markdown、刷新后仍在；图片不参与合并与内置 AI 改写。
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { openSample } from './helpers'

const paragraphs = (page: Page) => page.locator('.block-flow .block')
const figures = (page: Page) => page.locator('.block-flow .block-figure')

/** 在页面里画一张图，以粘贴或拖放的方式交给 App */
async function giveImage(page: Page, how: 'paste' | 'drop', color = '#3b82f6') {
  await page.evaluate(
    async ([how, color]) => {
      const canvas = document.createElement('canvas')
      canvas.width = 120
      canvas.height = 80
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 120, 80)
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'))
      const dt = new DataTransfer()
      dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
      if (how === 'paste') {
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      } else {
        const target = document.querySelector('.app') as HTMLElement
        target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
        target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      }
    },
    [how, color] as const
  )
}

async function loaded(page: Page, i = 0) {
  await expect
    .poll(() => figures(page).nth(i).locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(120)
}

test('粘贴图片：插在选中段落之后；写图注；导出 Markdown 是标准图片写法；刷新后仍在', async ({ page }) => {
  await openSample(page)
  await paragraphs(page).nth(0).click()
  await giveImage(page, 'paste')
  await expect(page.getByText('已插入图片 · 按 E 写图注')).toBeVisible()
  await expect(figures(page)).toHaveCount(1)
  await loaded(page)
  // 插在"引言"正文之后，下一块是"水的经济学"标题
  const blocks = page.locator('.block-flow [data-block-id]')
  const order = await blocks.evaluateAll((els) => els.map((e) => (e.querySelector('.block-figure') ? 'IMG' : e.textContent?.slice(0, 4))))
  expect(order.slice(0, 4), JSON.stringify(order)).toEqual(['引言', '在这座城', 'IMG', '水的经济'])

  await expect(page.getByText('没有图注 · 按 E 添加')).toBeVisible()
  await page.keyboard.press('e')
  await page.getByLabel('编辑图注').fill('城里唯一一张雨的照片')
  await page.keyboard.press('Enter')
  await expect(figures(page).locator('figcaption')).toHaveText('城里唯一一张雨的照片')
  await expect(page.locator('.block.active .block-meta-line')).toContainText('图片')

  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+Shift+e')])
  const md = readFileSync((await download.path())!, 'utf8')
  expect(md).toMatch(/\n\n!\[城里唯一一张雨的照片\]\(d_[a-z0-9]+\.assets\/[0-9a-f]{16}\.png\)\n\n## 水的经济学/)

  await page.reload()
  await page.locator('.block-flow .block').first().waitFor()
  await expect(figures(page).locator('figcaption')).toHaveText('城里唯一一张雨的照片')
  await loaded(page)
})

test('拖入图片；撤销能收回；同一张图只存一份', async ({ page }) => {
  await openSample(page)
  await paragraphs(page).nth(3).click()
  await giveImage(page, 'drop', '#ef4444')
  await expect(figures(page)).toHaveCount(1)
  await giveImage(page, 'drop', '#ef4444')
  await expect(figures(page)).toHaveCount(2)
  const srcs = await page.evaluate(async () => {
    const store = '/src/store/projectStore.ts' // 页面里由 Vite 解析
    const { useProjectStore } = await import(/* @vite-ignore */ store)
    return useProjectStore
      .getState()
      .data!.blocks.filter((b: { text: string }) => b.text.startsWith('!['))
      .map((b: { text: string }) => b.text)
  })
  expect(srcs[0]).toBe(srcs[1])
  await page.keyboard.press('Control+z')
  await expect(figures(page)).toHaveCount(1)
})

test('图片不和文字合并，也不能转成标题；内置 AI 不改写图片', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ai-writer:secret:apiKey:deepseek', 'sk-test'))
  await openSample(page)
  await paragraphs(page).nth(1).click()
  await giveImage(page, 'paste')
  await expect(figures(page)).toHaveCount(1)

  // 在图片下方新起一段，段首按退格：不会并进图片
  await figures(page).click({ button: 'right' })
  await page.locator('.context-menu').getByText('在下方插入段落').click()
  await page.keyboard.type('新的一段。')
  await page.keyboard.press('Home')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Escape')
  await expect(figures(page)).toHaveCount(1)
  await expect(page.locator('.block-flow .block-text', { hasText: '新的一段。' })).toHaveCount(1)

  // 右键菜单里没有"转为标题"，有"换图…"
  await figures(page).click({ button: 'right' })
  await expect(page.locator('.context-menu')).toContainText('换图…')
  await expect(page.locator('.context-menu')).not.toContainText('转为标题')
  await page.keyboard.press('Escape')

  await figures(page).click()
  await page.keyboard.press('Space')
  await expect(page.locator('.ai-prompt-scope')).toContainText('这张图片')
  await page.keyboard.press('Enter')
  await expect(page.getByText('内置 AI 看不到图片')).toBeVisible()
})

test('导出 HTML：单个文件，图片内嵌，Markdown 已渲染；浏览器模式导出 Markdown 会提示图片不在其中', async ({ page }) => {
  await openSample(page)
  await paragraphs(page).nth(0).click()
  await giveImage(page, 'paste')
  await page.keyboard.press('e')
  await page.getByLabel('编辑图注').fill('雨')
  await page.keyboard.press('Enter')

  await page.getByRole('button', { name: '文件' }).click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出 HTML（图片内嵌）…' }).click()])
  const html = readFileSync((await download.path())!, 'utf8')
  expect(html).toMatch(/^<!doctype html>/)
  expect(html).toMatch(/<figure><img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="雨"><figcaption>雨<\/figcaption><\/figure>/)
  expect(html).toContain('<h2>水的经济学</h2>')

  await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+Shift+e')])
  await expect(page.getByText('浏览器模式下图片没法一起导出')).toBeVisible()
})

test('导入的 Markdown 引用了不存在的图片：显示缺失与路径', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '粘贴导入…' }).click()
  await page.getByLabel('要导入的内容').fill('# 稿\n\n第一段。\n\n![示意图](images/not-here.png)\n\n第二段。')
  await page.getByRole('button', { name: /^导入/ }).click()
  await expect(page.getByText('找不到图片：images/not-here.png')).toBeVisible()
  await expect(figures(page).locator('figcaption')).toHaveText('示意图')
})

/**
 * 正文列随窗口变宽：字号跟着窗口变大，列宽按"每行约多少字"算；设置里可固定字号、调宽度。
 */
import { expect, test, type Page } from '@playwright/test'

async function measure(page: Page) {
  return page.evaluate(() => {
    const col = document.querySelector('.column')!.getBoundingClientRect().width
    const fs = parseFloat(getComputedStyle(document.querySelector('.block-text, .block-edit')!).fontSize)
    return { col, fs }
  })
}

test('宽屏上字号与正文列一起变大，每行字数不变', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await page.getByRole('button', { name: '从空白开始写' }).click()
  await page.keyboard.type('雨停的时候已经过了十二点')
  await page.keyboard.press('Escape')
  const small = await measure(page)
  expect(small.fs).toBe(17)
  await page.setViewportSize({ width: 2560, height: 1440 })
  const big = await measure(page)
  expect(big.fs).toBe(22)
  expect(big.col).toBeGreaterThan(small.col + 150)
  expect(Math.round((big.col - 64) / big.fs)).toBe(Math.round((small.col - 64) / small.fs))
})

test('设置：正文宽度、固定字号、正文字体，重新打开后仍然生效', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 })
  await page.goto('/')
  await page.getByRole('button', { name: '从空白开始写' }).click()
  await page.keyboard.type('雨停的时候已经过了十二点')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tablist', { name: '正文宽度' }).getByRole('tab', { name: '宽' }).click()
  await page.getByRole('tablist', { name: '正文字号' }).getByRole('tab', { name: '中' }).click()
  await page.getByRole('tablist', { name: '正文字体' }).getByRole('tab', { name: '楷体' }).click()
  await page.keyboard.press('Escape')
  const after = await measure(page)
  expect(after.fs).toBe(18)
  expect(Math.round((after.col - 64) / after.fs)).toBe(52)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-font', 'kai')
  await expect(page.locator('html')).toHaveAttribute('data-measure', 'wide')
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'm')
})

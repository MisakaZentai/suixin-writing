/**
 * 第 8 步回归：离线可用的正文字体、字体偏好、文字对比度达到 WCAG AA。
 */
import { expect, test } from '@playwright/test'
import { openSample } from './helpers'

test('不再向外部请求字体，正文用内置思源宋体', async ({ page }) => {
  const external: string[] = []
  page.on('request', (req) => {
    const url = req.url()
    if (!url.startsWith('http://localhost')) external.push(url)
  })
  await openSample(page)
  await page.waitForLoadState('networkidle')
  expect(external).toEqual([])
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready
    return document.fonts.check('17px "Noto Serif SC"', '雨')
  })
  expect(loaded).toBe(true)
})

test('正文字体可选，刷新后保留', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('tab', { name: '楷体' }).click()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-font', 'kai')
})

for (const scheme of ['light', 'dark'] as const) {
  test(`次要文字对比度达到 4.5:1（${scheme === 'light' ? '浅色' : '深色'}）`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme })
    const page = await context.newPage()
    await page.goto('/')
    const ratios = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement)
      const hex = (name: string) => css.getPropertyValue(name).trim()
      const lum = (h: string) => {
        const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        const [r, g, b] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const ratio = (a: string, b: string) => {
        const [x, y] = [lum(hex(a)), lum(hex(b))].sort((m, n) => n - m)
        return (x + 0.05) / (y + 0.05)
      }
      return {
        secondaryOnCanvas: ratio('--text-secondary', '--bg-canvas'),
        tertiaryOnCanvas: ratio('--text-tertiary', '--bg-canvas'),
        secondaryOnCard: ratio('--text-secondary', '--bg-card'),
        tertiaryOnCard: ratio('--text-tertiary', '--bg-card'),
      }
    })
    for (const [name, value] of Object.entries(ratios)) {
      expect(value, name).toBeGreaterThanOrEqual(4.5)
    }
    await context.close()
  })
}

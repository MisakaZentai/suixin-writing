import { expect, test } from '@playwright/test'
import { openSample } from './helpers'

test('空状态可见，示例文稿可载入', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('载入示例《没有雨的城市》')).toBeVisible()
  await openSample(page)
  await expect(page.locator('.block-flow .block').first()).toContainText('雨')
})

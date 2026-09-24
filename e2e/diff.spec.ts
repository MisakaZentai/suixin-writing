/**
 * 第 6 步回归：对照确认——逐处裁决、整体模式、不自动提交、稍后 / 放弃 / 改一改 / 再来一版、过期。
 */
import { expect, test, type Page } from '@playwright/test'
import { mockAI, openSample } from './helpers'

const ORIGINAL =
  '在这座城市里，雨是一种被审计的液体。每一滴水的下落都要经过市政厅的批准，未经登记的降水会被蒸发装置在半空拦截。市民们习惯了仰着头走路，不是为了看天，而是为了确认今天有没有谁偷偷下了雨。'
/** 两处小改动：第一句"被 → 要被"，第三句"谁 → 人" */
const SMALL =
  '在这座城市里，雨是一种要被审计的液体。每一滴水的下落都要经过市政厅的批准，未经登记的降水会被蒸发装置在半空拦截。市民们习惯了仰着头走路，不是为了看天，而是为了确认今天有没有人偷偷下了雨。'
const BIG = '雨在这里要登记。没登记的雨会被拦下。人们抬头走路，只为看看有没有人偷偷下雨。'

const first = (page: Page) => page.locator('.block-flow .block').first()
const bar = (page: Page) => page.locator('.diff-bar')

async function askAI(page: Page) {
  await first(page).click()
  await page.keyboard.press('Space')
  await page.keyboard.press('Enter')
  await expect(page.locator('.diff-view')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ai-writer:secret:apiKey:deepseek', 'sk-test'))
})

test('小改动：标注视图逐处裁决，裁决完也不自动提交，Enter 才完成', async ({ page }) => {
  await mockAI(page, () => SMALL)
  await openSample(page)
  await askAI(page)
  await expect(page.locator('.diff-cluster')).toHaveCount(2)
  await expect(bar(page)).toContainText('2 处改动')
  await page.keyboard.press('y')
  await page.keyboard.press('n')
  await page.waitForTimeout(600)
  await expect(page.locator('.diff-view')).toBeVisible()
  await expect(bar(page).getByRole('button', { name: /完成/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('.diff-view')).toHaveCount(0)
  await expect(first(page).locator('.block-text')).toHaveText(
    ORIGINAL.replace('一种被审计', '一种要被审计')
  )
})

test('改动很大：默认只看修改后，整体接受', async ({ page }) => {
  await mockAI(page, () => BIG)
  await openSample(page)
  await askAI(page)
  await expect(bar(page)).toContainText('改动较大')
  await expect(page.locator('.diff-cluster')).toHaveCount(0)
  await expect(page.locator('.diff-view .prose')).toHaveText(BIG)
  await bar(page).getByRole('tab', { name: '对照' }).click()
  await expect(page.locator('.diff-compare-label')).toHaveText(['原文', '修改后'])
  await bar(page).getByRole('button', { name: /^接受/ }).click()
  await expect(first(page).locator('.block-text')).toHaveText(BIG)
})

test('Esc 稍后再说：正文不变，保留为待确认，随时可以回来', async ({ page }) => {
  await mockAI(page, () => SMALL)
  await openSample(page)
  await askAI(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.diff-view')).toHaveCount(0)
  await expect(first(page).locator('.block-text')).toHaveText(ORIGINAL)
  await first(page).getByRole('button', { name: /AI 修改待确认/ }).click()
  await expect(page.locator('.diff-view')).toBeVisible()
})

test('放弃：正文不变，也不再待确认', async ({ page }) => {
  await mockAI(page, () => SMALL)
  await openSample(page)
  await askAI(page)
  await page.keyboard.press('Backspace')
  await expect(page.locator('.diff-view')).toHaveCount(0)
  await expect(first(page).locator('.block-text')).toHaveText(ORIGINAL)
  await expect(first(page).getByRole('button', { name: /AI 修改待确认/ })).toHaveCount(0)
})

test('再来一版：多个候选可以来回切换，接受选中的那一版', async ({ page }) => {
  let n = 0
  await mockAI(page, () => (++n === 1 ? SMALL : BIG))
  await openSample(page)
  await askAI(page)
  await page.keyboard.press('r')
  await expect(bar(page)).toContainText('2 / 2')
  await expect(page.locator('.diff-view .prose')).toHaveText(BIG)
  await page.keyboard.press('ArrowLeft')
  await expect(bar(page)).toContainText('1 / 2')
  await page.keyboard.press('Enter')
  await expect(first(page).locator('.block-text')).toHaveText(SMALL)
})

test('改一改：接受后直接在 AI 的稿子上编辑', async ({ page }) => {
  await mockAI(page, () => BIG)
  await openSample(page)
  await askAI(page)
  await bar(page).getByRole('button', { name: '改一改' }).click()
  const editor = page.locator('textarea.block-edit')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue(BIG)
  await page.keyboard.type('（我再补一句）')
  await page.keyboard.press('Escape')
  await expect(first(page).locator('.block-text')).toHaveText(`${BIG}（我再补一句）`)
})

test('原文在生成后被改动：这条修改标记过期，不能接受', async ({ page }) => {
  await mockAI(page, () => SMALL)
  await openSample(page)
  await askAI(page)
  await page.keyboard.press('Escape')
  await first(page).dblclick()
  await page.keyboard.press('End')
  await page.keyboard.type('（手改）')
  await page.keyboard.press('Escape')
  await first(page).getByRole('button', { name: /AI 修改待确认/ }).click()
  await expect(bar(page)).toContainText('已过期')
  await expect(bar(page).getByRole('button', { name: /^接受/ })).toHaveCount(0)
  await expect(bar(page).getByRole('button', { name: '重新生成' })).toBeVisible()
})

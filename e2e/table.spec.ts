/**
 * 表格：阅读时渲染成表格（文字仍与源文字逐字对应），编辑时是源码；
 * 右键插入、回车加行、空行回车结束表格；从表格软件粘贴转成 Markdown 表格。
 */
import { expect, test, type Page } from '@playwright/test'
import { openSample } from './helpers'

const blocks = (page: Page) => page.locator('.block-flow .block')
const cellTexts = (page: Page) =>
  page.locator('.md-table .md-tr').evaluateAll((rows) => rows.map((r) => Array.from(r.querySelectorAll('.md-td'), (c) => c.textContent)))

/** 模拟从 Excel 复制：剪贴板里同时有按制表符分列的文字和一张截图 */
async function pasteCells(page: Page, text: string, target: 'body' | 'textarea') {
  await page.evaluate(
    async ([text, target]) => {
      const canvas = document.createElement('canvas')
      canvas.width = 40
      canvas.height = 20
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'))
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      dt.items.add(new File([blob], 'cells.png', { type: 'image/png' }))
      const el = target === 'body' ? document.body : (document.querySelector('textarea.block-edit') as HTMLElement)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    [text, target] as const
  )
}

test('右键插入表格：填表头、回车加行、最后一行空着回车就结束表格', async ({ page }) => {
  await openSample(page)
  await blocks(page).nth(1).click({ button: 'right' })
  await page.getByRole('button', { name: '在下方插入表格' }).click()
  const editor = page.locator('textarea.block-edit')
  await expect(editor).toHaveValue('| 列 1 | 列 2 |\n| --- | --- |\n|  |  |')
  await expect(page.locator('.block-meta-line')).toContainText('表格里 ↵ 加一行')

  await page.keyboard.press('Delete')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Delete')
  await page.keyboard.type('模型')
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('mimo')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('ds')
  await expect(editor).toHaveValue('| 模型 | 列 2 |\n| --- | --- |\n| mimo |  |\n| ds |  |')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter') // 空行上回车：结束表格，另起一段
  await page.keyboard.type('表格后面的一段。')
  await page.keyboard.press('Escape')

  await expect(cellTexts(page)).resolves.toEqual([
    ['模型', '列 2'],
    ['mimo', ''],
    ['ds', ''],
  ])
  await expect(blocks(page).nth(3).locator('.block-text')).toHaveText('表格后面的一段。')
  // 竖线与分隔行只是隐藏：块里的文字仍是源码（划选、双击落点按源文字算）
  const source = await blocks(page).nth(2).locator('.block-text').evaluate((el) => el.textContent)
  expect(source).toBe('| 模型 | 列 2 |\n| --- | --- |\n| mimo |  |\n| ds |  |')
})

test('从表格软件粘贴：编辑时插进输入框，选中段落时另起一段，不当成图片', async ({ page }) => {
  await openSample(page)
  await blocks(page).first().click()
  await pasteCells(page, '模型\t用时\r\nmimo\t2h40m\r\nds\t40m\r\n', 'body')
  await expect(blocks(page).nth(1).locator('.md-table')).toBeVisible()
  await expect(cellTexts(page)).resolves.toEqual([
    ['模型', '用时'],
    ['mimo', '2h40m'],
    ['ds', '40m'],
  ])
  await expect(page.locator('.block-flow figure')).toHaveCount(0)

  await blocks(page).nth(2).dblclick()
  const editor = page.locator('textarea.block-edit')
  await editor.press('Control+End')
  await pasteCells(page, 'a\tb\nc\td', 'textarea')
  await expect(editor).toHaveValue(/\n\| a \| b \|\n\| --- \| --- \|\n\| c \| d \|$/)
  await expect(page.locator('.block-flow figure')).toHaveCount(0)
})

/**
 * Markdown 模式：阅读时显示效果、编辑时语法就地生效；格式浮条与快捷键；
 * 标记只是隐藏，文字偏移不变（双击落点、划选都按源文字计算）。
 */
import { expect, test, type Page } from '@playwright/test'

async function startBlank(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: '从空白开始写' }).click()
  await expect(page.locator('textarea.block-edit')).toBeFocused()
}

const para = (page: Page, n = 0) => page.locator('.block-flow .block .block-text').nth(n)
const editor = (page: Page) => page.locator('textarea.block-edit')

/** 在编辑框里选中某段文字 */
async function selectInEditor(page: Page, text: string) {
  await editor(page).evaluate((el: HTMLTextAreaElement, t) => {
    const s = el.value.indexOf(t)
    el.setSelectionRange(s, s + t.length)
    el.dispatchEvent(new Event('select'))
  }, text)
}

test('阅读时显示效果，标记隐藏；DOM 文字仍与源文字一致', async ({ page }) => {
  await startBlank(page)
  await page.keyboard.type('前面**加粗**、*斜体*、~~删除~~、`代码`和[链接](https://example.com)')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('- 列表一')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('- 列表二')
  await page.keyboard.press('Escape')
  const p = para(page)
  await expect(p.locator('strong')).toHaveText('**加粗**')
  await expect(p.locator('strong .md-mark').first()).toBeHidden()
  await expect(p.locator('em')).toHaveText('*斜体*')
  await expect(p.locator('del')).toHaveText('~~删除~~')
  await expect(p.locator('code')).toHaveText('`代码`')
  await expect(p.locator('.md-link')).toHaveAttribute('title', 'https://example.com')
  await expect(p.locator('.md-ul')).toHaveCount(2)
  // 看到的文字没有标记，但 DOM 里的文字与源文字逐字相同
  expect(await p.innerText()).not.toContain('**')
  expect(await p.textContent()).toBe('前面**加粗**、*斜体*、~~删除~~、`代码`和[链接](https://example.com)\n- 列表一\n- 列表二')
})

test('编辑时：垫层显示带样式的源码，输入框文字透明', async ({ page }) => {
  await startBlank(page)
  await page.keyboard.type('这是**加粗**')
  await expect(editor(page)).toHaveClass(/md-on/)
  const backdrop = page.locator('.md-backdrop')
  await expect(backdrop.locator('strong')).toHaveText('**加粗**')
  await expect(backdrop.locator('.md-mark').first()).toBeVisible() // 编辑时标记可见（变淡）
  // 垫层与输入框逐行对齐：行数一样
  const [taLines, bdLines] = await page.evaluate(() => {
    const t = document.querySelector('textarea.block-edit') as HTMLTextAreaElement
    const b = document.querySelector('.md-backdrop') as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(b)
    const tops = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top)))
    return [Math.round(t.clientHeight / parseFloat(getComputedStyle(t).lineHeight)), tops.size]
  })
  expect(bdLines).toBe(taLines)
})

test('格式浮条：选中文字出现；加粗、再点一次取消；Ctrl+Z 撤销', async ({ page }) => {
  await startBlank(page)
  await page.keyboard.type('雨停的时候已经过了十二点')
  await expect(page.getByRole('toolbar', { name: '格式' })).toHaveCount(0) // 没有选中文字时不出现
  await selectInEditor(page, '十二点')
  const bar = page.getByRole('toolbar', { name: '格式' })
  await expect(bar).toBeVisible()
  await bar.getByRole('button', { name: '加粗' }).click()
  await expect(editor(page)).toHaveValue('雨停的时候已经过了**十二点**')
  // 选区仍是那几个字，再点一次取消
  expect(await editor(page).evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('十二点')
  await bar.getByRole('button', { name: '加粗' }).click()
  await expect(editor(page)).toHaveValue('雨停的时候已经过了十二点')
  await bar.getByRole('button', { name: '引用' }).click()
  await expect(editor(page)).toHaveValue('> 雨停的时候已经过了十二点')
  // 原生撤销：一步步退回去
  await page.keyboard.press('Control+z')
  await expect(editor(page)).toHaveValue('雨停的时候已经过了十二点')
  await page.keyboard.press('Control+z')
  await expect(editor(page)).toHaveValue('雨停的时候已经过了**十二点**')
})

test('快捷键：Ctrl+B / Ctrl+I / Ctrl+K', async ({ page }) => {
  await startBlank(page)
  await page.keyboard.type('一二三')
  await selectInEditor(page, '二')
  await page.keyboard.press('Control+b')
  await expect(editor(page)).toHaveValue('一**二**三')
  await page.keyboard.press('Control+i')
  await expect(editor(page)).toHaveValue('一***二***三')
  await selectInEditor(page, '三')
  await page.keyboard.press('Control+k')
  await expect(editor(page)).toHaveValue('一***二***[三](https://)')
  // 地址被选中，直接输入就替换
  await page.keyboard.type('https://a.cn')
  await expect(editor(page)).toHaveValue('一***二***[三](https://a.cn)')
  // 全局的 Ctrl+B 等不会被触发（还在编辑）
  await expect(editor(page)).toBeFocused()
})

test('阅读时划选文字：浮条里直接加格式，作为作者的修改写入', async ({ page }) => {
  await startBlank(page)
  await page.keyboard.type('城里流通两种货币')
  await page.keyboard.press('Escape')
  await para(page).evaluate((el) => {
    const node = el.firstChild as Text
    const range = document.createRange()
    range.setStart(node, 2)
    range.setEnd(node, 4)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  })
  const bubble = page.locator('.selection-bubble')
  await expect(bubble.getByRole('button', { name: /AI 改选中的文字/ })).toBeVisible()
  await bubble.getByRole('toolbar', { name: '格式' }).getByRole('button', { name: '加粗' }).click()
  await expect(para(page).locator('strong')).toHaveText('**流通**')
  expect(await para(page).textContent()).toBe('城里**流通**两种货币')
  await expect(bubble).toHaveCount(0)
})

test('双击加粗的文字：光标落在源文字的对应位置（隐藏的标记也算进偏移）', async ({ page }) => {
  await startBlank(page)
  await page.keyboard.type('前面前面**加粗的一段文字**后面')
  await page.keyboard.press('Escape')
  const strong = para(page).locator('strong')
  const box = (await strong.boundingBox())!
  await strong.dblclick({ position: { x: box.width - 4, y: box.height / 2 } })
  const caret = await editor(page).evaluate((el: HTMLTextAreaElement) => el.selectionStart)
  const src = '前面前面**加粗的一段文字**后面'
  // 点在"字"的右半边：光标在"字"之后、收尾的 ** 之前附近
  expect(caret).toBeGreaterThanOrEqual(src.indexOf('文字') + 1)
  expect(caret).toBeLessThanOrEqual(src.indexOf('**后面'))
})

test('设置里切到「显示源码」：一律显示 Markdown 原文', async ({ page }) => {
  await startBlank(page)
  await page.keyboard.type('这是**加粗**')
  await page.keyboard.press('Escape')
  await expect(para(page).locator('strong')).toHaveCount(1)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tablist', { name: 'Markdown' }).getByRole('tab', { name: '显示源码' }).click()
  await page.keyboard.press('Escape')
  await expect(para(page).locator('strong')).toHaveCount(0)
  await expect(para(page)).toHaveText('这是**加粗**')
  expect(await para(page).innerText()).toContain('**')
  // 编辑时输入框文字不透明（没有垫层效果）
  await para(page).dblclick()
  await expect(editor(page)).not.toHaveClass(/md-on/)
})

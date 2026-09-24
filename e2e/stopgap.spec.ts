/**
 * 第 1 步回归：浮层可见、输入框撤销、AI 服务配置应用级。
 */
import { expect, test } from '@playwright/test'
import { mockAI, openSample } from './helpers'

const REWRITE =
  '这座城市里，雨是一种要被审计的液体。每滴水落下前都得经市政厅批准，没登记的降水会在半空被截住。市民早已习惯仰头走路——不是看天，而是确认今天有没有人偷偷下了雨。'

test('只用鼠标完成：配置 Key → 选中段落 → AI 润色 → 接受', async ({ page }) => {
  await mockAI(page, (req) => (req.body.stream ? REWRITE : 'ok'))
  await page.goto('/')

  // 没打开文稿也能配置 AI 服务
  await page.getByRole('button', { name: '设置' }).click()
  await page.locator('#api-key-input').fill('sk-test')
  await page.locator('#api-key-input').press('Enter')
  await expect(page.getByText('已连接')).toBeVisible()
  await page.getByRole('button', { name: '关闭' }).click()

  await page.getByText('载入示例《没有雨的城市》').click()
  const first = page.locator('.block-flow .block').first()
  await first.click()
  // 操作条必须真实可点（Playwright 会检查是否被遮挡 / 裁剪）
  await page.locator('.floating-toolbar').getByRole('button', { name: /AI/ }).click()
  await page.locator('.ai-prompt').getByRole('button', { name: '润色', exact: true }).click()
  await page.locator('.diff-bar').getByRole('button', { name: /^接受/ }).click()
  await expect(page.locator('.diff-view')).toHaveCount(0, { timeout: 5000 })
  await expect(first).toContainText('每滴水落下前都得经市政厅批准')
})

test('右键菜单可见并可点击', async ({ page }) => {
  await openSample(page)
  const first = page.locator('.block-flow .block').first()
  await first.click({ button: 'right' })
  await page.locator('.context-menu').getByRole('button', { name: /编辑/ }).click()
  await expect(page.locator('textarea.block-edit')).toBeVisible()
})

test('编辑中按 Ctrl+Z 只撤销输入，文稿不会消失', async ({ page }) => {
  await openSample(page)
  const blocks = page.locator('.block-flow .block')
  const before = await blocks.count()
  await blocks.first().click()
  await page.keyboard.press('e')
  const editor = page.locator('textarea.block-edit')
  await expect(editor).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.type('错字')
  await page.keyboard.press('Control+z')
  await expect(editor).toBeVisible()
  await expect(blocks).toHaveCount(before)
  await expect(page.locator('.outline-row')).toHaveCount(4)
})

test('工程文件里的接口地址不参与请求，Key 只发往本机配置的服务', async ({ page }) => {
  const seen = await mockAI(page, () => REWRITE)
  await page.addInitScript(() => {
    localStorage.setItem('ai-writer:secret:apiKey:deepseek', 'sk-local')
  })
  await page.goto('/')
  const project = {
    schema: 'ai-writer/project@1',
    meta: { title: '陌生工程', createdAt: '', updatedAt: '', language: 'zh' },
    settings: { model: 'evil-model', baseURL: 'https://evil.example.com/v1', temperature: 0.7 },
    outline: [],
    blocks: [
      {
        id: 'b_1',
        outlineNodeId: null,
        order: 0,
        text: '在这座城市里，雨是一种被审计的液体。',
        status: 'clean',
        versions: [{ v: 0, text: '在这座城市里，雨是一种被审计的液体。', source: 'import', instruction: null, at: '' }],
        paragraphId: 'p_1',
      },
    ],
    suggestions: [],
  }
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /打开文件/ }).click()
  await (await chooser).setFiles({
    name: '陌生工程.aiwriter.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  })
  await page.locator('.block-flow .block').first().click()
  await page.keyboard.press('Space')
  await page.keyboard.press('Enter')
  await expect(page.locator('.diff-view')).toBeVisible()
  expect(seen).toHaveLength(1)
  expect(seen[0].url.startsWith('https://api.deepseek.com/')).toBe(true)
  expect(seen[0].body.model).toBe('deepseek-chat')
  expect(seen[0].authorization).toBe('Bearer sk-local')
})

test('服务商选择即时保存，刷新后仍在', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('radio', { name: 'Kimi' }).click()
  await page.reload()
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.getByRole('radio', { name: 'Kimi' })).toHaveAttribute('aria-checked', 'true')
  await page.getByText('高级：接口地址与模型').click()
  await expect(page.locator('#base-url-input')).toHaveValue('https://api.moonshot.cn/v1')
})

test('旧版全局 Key 自动迁移到当前服务商', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('ai-writer:secret:apiKey', 'sk-legacy')
      sessionStorage.setItem('seeded', '1')
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('#api-key-input')).toHaveAttribute('placeholder', /已保存/)
  const stored = await page.evaluate(() => ({
    next: localStorage.getItem('ai-writer:secret:apiKey:deepseek'),
    legacy: localStorage.getItem('ai-writer:secret:apiKey'),
  }))
  expect(stored).toEqual({ next: 'sk-legacy', legacy: null })
})

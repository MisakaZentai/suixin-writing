/**
 * A4.4 知乎发布包：在模拟的知乎写文章页里执行 publish.js。
 * 模拟页按知乎编辑器的方式处理粘贴（文字插入正文；图片先显示 blob: 占位，稍后换成 zhimg 图床地址，
 * 下方出现"添加图片注释"）。真实知乎的行为需要在作者的账号下另行验证。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { runCli } from '../cli/suixin'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG2 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8Dwn4GBgQEAFAgCAH5N5dsAAAAASUVORK5CYII='

const MOCK = `<!doctype html><html><head><meta charset="utf-8"><title>写文章 - 知乎</title></head><body>
<textarea placeholder="请输入标题（最多 100 个字）" class="Input"></textarea>
<div class="DraftEditor-root"><div class="public-DraftEditor-content" contenteditable="true" role="textbox"></div></div>
<button id="publish" onclick="window.__published = true">发布</button>
<script>
  const editor = document.querySelector('.public-DraftEditor-content')
  window.__log = []
  let n = 0
  editor.addEventListener('paste', (e) => {
    e.preventDefault()
    const files = Array.from(e.clipboardData.files)
    if (files.length) {
      const fig = document.createElement('figure')
      const img = document.createElement('img')
      img.src = URL.createObjectURL(files[0])
      const cap = document.createElement('textarea')
      cap.placeholder = '添加图片注释（不超过 140 字）'
      fig.append(img, cap)
      editor.append(fig)
      window.__log.push('image:' + files[0].name + ':' + files[0].type)
      const id = ++n
      setTimeout(() => { img.src = 'https://pic' + id + '.zhimg.com/v2-fake' + id + '.png' }, 400)
    } else {
      const wrap = document.createElement('div')
      wrap.innerHTML = e.clipboardData.getData('text/html')
      editor.append(...wrap.childNodes)
      window.__log.push('html')
    }
  })
</script></body></html>`

test('publish.js 在知乎写文章页按顺序填入标题、正文与图片，等图片传完，补图注，不点发布', async ({ page }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'suixin-zhihu-'))
  try {
    const cli = async (args: string[]) => {
      let out = ''
      await runCli(args, { stdout: (t) => (out += t), stderr: () => {}, readStdin: async () => '', env: { SUIXIN_NO_BRIDGE: '1' }, cwd: dir })
      return JSON.parse(out)
    }
    writeFileSync(path.join(dir, 'a.png'), Buffer.from(PNG, 'base64'))
    writeFileSync(path.join(dir, 'b.png'), Buffer.from(PNG2, 'base64'))
    writeFileSync(
      path.join(dir, 'a.md'),
      '# 没有雨的城市\n\n## 引言\n\n雨是**被审计**的液体。\n\n![第一张](a.png)\n\n- 水票\n- 信用点\n\n![](b.png)\n\n## 尾声\n\n市政厅没有解释。\n'
    )
    // 图片路径相对于工程文件，a.png / b.png 就在旁边
    await cli(['new', '稿.suixin.json', '--from', 'a.md'])

    const pkg = await cli(['export', '稿.suixin.json', '--format', 'zhihu', '-o', 'zhihu'])
    expect(pkg).toMatchObject({ ok: true, title: '没有雨的城市', images: 2, missing: [], parts: 5 })
    expect(pkg.scripts).toHaveLength(1)
    expect(readdirSync(path.join(dir, 'zhihu')).sort()).toEqual(['content.html', 'images', 'publish.js', '说明.md'])

    await page.route('https://zhuanlan.zhihu.com/write', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: MOCK }))
    await page.goto('https://zhuanlan.zhihu.com/write')
    const result = await page.evaluate(readFileSync(pkg.scripts[0], 'utf8'))
    expect(result).toMatchObject({ ok: true, done: 5, total: 5, images: 2, uploaded: 2, captions: 1, failed: [], title: true })

    await expect(page.locator('textarea.Input')).toHaveValue('没有雨的城市')
    expect(await page.evaluate(() => (window as unknown as { __log: string[] }).__log)).toEqual([
      'html',
      'image:a.png:image/png',
      'html',
      'image:b.png:image/png',
      'html',
    ])
    const editor = page.locator('.public-DraftEditor-content')
    await expect(editor.locator('h2')).toHaveText(['引言', '尾声'])
    await expect(editor.locator('strong')).toHaveText('被审计')
    await expect(editor.locator('li')).toHaveText(['水票', '信用点'])
    await expect(editor.locator('img')).toHaveCount(2)
    expect(await editor.locator('img').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src))).toEqual([
      'https://pic1.zhimg.com/v2-fake1.png',
      'https://pic2.zhimg.com/v2-fake2.png',
    ])
    await expect(editor.locator('figure textarea').first()).toHaveValue('第一张')
    expect(await page.evaluate(() => (window as unknown as { __published?: boolean }).__published)).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('App「发布到知乎」：逐段复制——文字是富文本，图片是 PNG', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  await page.getByText('载入示例《没有雨的城市》').click()
  await page.locator('.block-flow .block').first().waitFor()
  // 插一张图
  await page.locator('.block-flow .block').first().click()
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 30
    canvas.height = 20
    canvas.getContext('2d')!.fillRect(0, 0, 30, 20)
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'x.png', { type: 'image/png' }))
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await page.locator('.block-flow .block-figure').waitFor()

  await page.getByRole('button', { name: '文件' }).click()
  await page.getByRole('button', { name: '发布到知乎…' }).click()
  const dialog = page.getByRole('dialog', { name: '发布到知乎' })
  const steps = dialog.locator('.publish-steps li')
  await expect(steps).toHaveCount(4) // 标题、文字、图片、文字
  await expect(steps.nth(0)).toContainText('没有雨的城市')
  await expect(steps.nth(2)).toContainText('图片')

  await steps.nth(1).getByRole('button', { name: '复制' }).click()
  await expect(steps.nth(1)).toHaveClass(/done/)
  const html = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read()
    return (await item.getType('text/html')).text()
  })
  expect(html).toContain('<h2>引言</h2>')

  await steps.nth(2).getByRole('button', { name: '复制图片' }).click()
  await expect(steps.nth(2)).toHaveClass(/done/)
  const types = await page.evaluate(async () => (await navigator.clipboard.read())[0].types)
  expect(types).toEqual(['image/png'])
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('不在知乎页面执行：不做任何事，给出提示', async ({ page }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'suixin-zhihu-'))
  try {
    let out = ''
    writeFileSync(path.join(dir, 'a.md'), '# 稿\n\n一段。\n')
    await runCli(['new', '稿.suixin.json', '--from', 'a.md'], { stdout: () => {}, stderr: () => {}, readStdin: async () => '', env: {}, cwd: dir })
    await runCli(['export', '稿.suixin.json', '--format', 'zhihu', '-o', 'z'], {
      stdout: (t) => (out += t),
      stderr: () => {},
      readStdin: async () => '',
      env: { SUIXIN_NO_BRIDGE: '1' },
      cwd: dir,
    })
    await page.goto('/')
    const result = (await page.evaluate(readFileSync(JSON.parse(out).scripts[0], 'utf8'))) as { error: string }
    expect(result).toMatchObject({ ok: false, done: 0 })
    expect(result.error).toContain('知乎写文章页面')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

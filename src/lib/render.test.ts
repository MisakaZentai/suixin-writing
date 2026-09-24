import { describe, expect, it } from 'vitest'
import { renderBody, renderPage, renderParts, type RenderDoc } from './render'

const doc: RenderDoc = {
  title: '没有雨的城市',
  blocks: [
    { type: 'heading', level: 2, text: '引言' },
    { type: 'paragraph', text: '雨是**被审计**的液体，见[市政厅](https://example.com)。\n第二行。' },
    { type: 'paragraph', text: '![城里唯一一张雨的照片](稿.assets/a.png)' },
    { type: 'paragraph', text: '- 水票\n- 信用点' },
    { type: 'paragraph', text: '> 我们是预测对了太多次。' },
    { type: 'paragraph', text: '<script>alert(1)</script>[坏链接](javascript:alert(1))' },
    { type: 'paragraph', text: '![](missing.png)' },
  ],
}
const image = async (src: string) => (src === 'missing.png' ? null : `data:image/png;base64,AAAA#${src}`)

describe('渲染', () => {
  it('Markdown 渲染：加粗、链接、换行、列表、引用；标题在前', async () => {
    const html = await renderBody(doc, { image })
    expect(html).toContain('<h1>没有雨的城市</h1>')
    expect(html).toContain('<h2>引言</h2>')
    expect(html).toContain('<strong>被审计</strong>')
    expect(html).toContain('<a href="https://example.com">市政厅</a>')
    expect(html).toContain('<br>第二行。')
    expect(html).toMatch(/<ul>\s*<li>水票<\/li>\s*<li>信用点<\/li>\s*<\/ul>/)
    expect(html).toMatch(/<blockquote>\s*<p>我们是预测对了太多次。<\/p>/)
  })

  it('图片段落成为 图 + 图注；缺失的图片给出路径', async () => {
    const html = await renderBody(doc, { image })
    expect(html).toContain('<figure><img src="data:image/png;base64,AAAA#稿.assets/a.png" alt="城里唯一一张雨的照片"><figcaption>城里唯一一张雨的照片</figcaption></figure>')
    expect(html).toContain('图片缺失：missing.png')
  })

  it('原始 HTML 不执行，危险链接去掉', async () => {
    const html = await renderBody(doc, { image })
    expect(html).not.toContain('<script>')
    expect(html).toContain('<p>&lt;script&gt;')
    expect(html).not.toMatch(/href="javascript:/i)
    const link = await renderBody({ title: '', blocks: [{ type: 'paragraph', text: '[坏](javascript:alert%281%29) [好](https://a.com)' }] }, { image })
    expect(link).toBe('<p>坏 <a href="https://a.com">好</a></p>\n')
  })

  it('按块输出：文字与图片交替，供发布逐段粘贴', async () => {
    const parts = await renderParts(doc, { image, includeTitle: false })
    expect(parts.map((p) => p.kind)).toEqual(['html', 'image', 'html', 'image'])
    expect(parts[1]).toMatchObject({ kind: 'image', src: '稿.assets/a.png', caption: '城里唯一一张雨的照片' })
    expect(parts[3]).toMatchObject({ kind: 'image', url: null })
  })

  it('完整页面带样式与宽度', async () => {
    const page = await renderPage(doc, { image, style: 'zhihu', width: 600 })
    expect(page).toMatch(/^<!doctype html>/)
    expect(page).toContain('max-width:600px')
    expect(page).toContain('<title>没有雨的城市</title>')
  })
})

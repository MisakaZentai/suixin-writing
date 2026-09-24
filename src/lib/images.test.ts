import { describe, expect, it } from 'vitest'
import { contentName, imageLine, imageSize, isImageText, parseImage, preserveImages } from './images'
import { parseDocument, toMarkdown } from './markdown'
import { countChars } from './doc'

const png1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGP8z8DwnwEIGBkZGQAjAgMBqUKJ3QAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0)
)

describe('图片行', () => {
  it('解析与生成：图注里的方括号、路径里的空格都能来回', () => {
    expect(parseImage('![城市的雨](稿.assets/ab12.png)')).toEqual({ caption: '城市的雨', src: '稿.assets/ab12.png' })
    expect(parseImage('  ![](https://pic.example.com/a.jpg "标题")  ')).toEqual({ caption: '', src: 'https://pic.example.com/a.jpg' })
    const line = imageLine('图 [1]：雨', 'my docs/a b.png')
    expect(line).toBe('![图 \\[1\\]：雨](<my docs/a b.png>)')
    expect(parseImage(line)).toEqual({ caption: '图 [1]：雨', src: 'my docs/a b.png' })
    expect(isImageText('正文里提到 ![图](a.png) 不算')).toBe(false)
    expect(isImageText('![图](a.png)\n第二行')).toBe(false)
  })

  it('Markdown 导入导出：单独一段的图片原样往返；图片不计字数', () => {
    const md = '# 稿\n\n第一段。\n\n![雨](稿.assets/a.png)\n\n第二段。\n'
    const doc = parseDocument(md)
    expect(doc.blocks.map((b) => b.text)).toEqual(['第一段。', '![雨](稿.assets/a.png)', '第二段。'])
    expect(toMarkdown({ title: '稿' }, doc.blocks)).toBe(md)
    expect(countChars('![雨](稿.assets/a.png)')).toBe(0)
  })

  it('AI 改写一节丢了图片：放回原来的相对位置', () => {
    const original = '第一段。\n\n![图](a.png)\n\n第二段。\n\n第三段。'
    expect(preserveImages(original, '改后一。\n\n改后二。\n\n改后三。')).toBe('改后一。\n\n![图](a.png)\n\n改后二。\n\n改后三。')
    const kept = '改后一。\n\n![图](a.png)\n\n改后二。'
    expect(preserveImages(original, kept)).toBe(kept)
  })

  it('读出图片尺寸；按内容命名，同图同名', async () => {
    expect(imageSize(png1x1)).toEqual({ width: 2, height: 3 })
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull()
    const a = await contentName(png1x1, 'png')
    expect(a).toMatch(/^[0-9a-f]{16}\.png$/)
    expect(await contentName(png1x1, 'png')).toBe(a)
  })
})

import { describe, expect, it } from 'vitest'
import { publishScript, splitParts, zhihuHtml, type PublishPart } from './zhihu'

describe('知乎发布', () => {
  it('HTML 调整：一级标题降级、四级以下变加粗、表格按行变段落、分割线变破折号', () => {
    expect(zhihuHtml('<h1>大</h1><h4>小</h4>')).toBe('<h2>大</h2><p><strong>小</strong></p>')
    expect(zhihuHtml('<hr>')).toBe('<p>———</p>')
    expect(zhihuHtml('<table><thead><tr><th>货币</th><th>溢价</th></tr></thead><tbody><tr><td>水票</td><td>三成</td></tr></tbody></table>')).toBe(
      '<p>货币 | 溢价</p><p>水票 | 三成</p>'
    )
  })

  it('按大小拆分，顺序不变', () => {
    const parts: PublishPart[] = [
      { kind: 'html', html: 'a'.repeat(10) },
      { kind: 'image', name: '1.png', mime: 'image/png', base64: 'x'.repeat(50), caption: '' },
      { kind: 'html', html: 'b'.repeat(10) },
      { kind: 'image', name: '2.png', mime: 'image/png', base64: 'y'.repeat(50), caption: '' },
    ]
    const chunks = splitParts(parts, 60)
    expect(chunks.map((c) => c.length)).toEqual([2, 2])
    expect(chunks.flat()).toEqual(parts)
    expect(splitParts(parts, 1e9)).toHaveLength(1)
  })

  it('脚本可解析；只有第一段设置标题；数据原样内嵌', () => {
    const parts: PublishPart[] = [{ kind: 'html', html: '<p>一段 "引号" 与 </script> 字样</p>' }]
    const one = publishScript('标题', parts, { chunk: 1, chunks: 2 })
    const two = publishScript('标题', parts, { chunk: 2, chunks: 2 })
    expect(() => new Function(one)).not.toThrow()
    expect(one).toContain('"title":"标题"')
    expect(two).toContain('"title":null')
    expect(one).not.toMatch(/click\(\)/)
    expect(one).not.toContain('</script>')
    expect(one).toContain('\\u003c/script>')
  })
})

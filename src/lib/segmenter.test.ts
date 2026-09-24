import { describe, expect, it } from 'vitest'
import { splitSentences } from './segmenter'

describe('splitSentences', () => {
  it('中文按句读切分，拼接后无损', () => {
    const text = '第一句。第二句！第三句？'
    const parts = splitSentences(text)
    expect(parts).toHaveLength(3)
    expect(parts.join('')).toBe(text)
  })
})

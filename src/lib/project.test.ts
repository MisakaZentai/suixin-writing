import { describe, expect, it } from 'vitest'
import { exportMarkdown, parseProjectFile, projectFromText, serializeProject } from './project'

describe('工程文件', () => {
  it('序列化后再读取，内容一致且未知字段保留', () => {
    const { project } = projectFromText('# 标题\n\n## 一\n\n正文。\n')
    const withExtra = { ...project, externalAgent: { note: 'keep me' } }
    const back = parseProjectFile(serializeProject(withExtra))
    expect(back.blocks.map((b) => b.text)).toEqual(['一', '正文。'])
    expect((back as unknown as { externalAgent: unknown }).externalAgent).toEqual({ note: 'keep me' })
    expect(back.blocks[0]).not.toHaveProperty('status')
  })

  it('序列化时写出派生的 status，方便外部 agent 找到待确认段落', () => {
    const { project } = projectFromText('正文。')
    const id = project.blocks[0].id
    project.suggestions.push({
      id: 's1',
      kind: 'ai_diff',
      target: { blockIds: [id] },
      instruction: null,
      original: '正文。',
      proposed: '新正文。',
      diff: [],
      state: 'pending',
      createdAt: '',
    })
    const json = JSON.parse(serializeProject(project))
    expect(json.schema).toBe('suixin/project@2')
    expect(json.blocks[0].status).toBe('pending')
  })

  it('拒绝无法识别的文件', () => {
    expect(() => parseProjectFile('{"schema":"other"}')).toThrow(/无法识别/)
    expect(() => parseProjectFile('not json')).toThrow(/JSON/)
  })

  it('v1 工程迁移：句子拼回段落，大纲变成标题，待处理的段落级建议保留', () => {
    const v1 = {
      schema: 'ai-writer/project@1',
      meta: { title: '旧文稿', createdAt: '', updatedAt: '', language: 'zh' },
      settings: { model: 'x', baseURL: 'https://evil.example.com', temperature: 0.7 },
      outline: [
        { id: 'on_1', title: '引言', children: [{ id: 'on_2', title: '背景', children: [] }] },
        { id: 'on_3', title: '空章节', children: [] },
      ],
      blocks: [
        { id: 'b1', outlineNodeId: 'on_1', order: 0, text: '第一句。', status: 'clean', versions: [], paragraphId: 'p1' },
        { id: 'b2', outlineNodeId: 'on_1', order: 1, text: '第二句。', status: 'clean', versions: [], paragraphId: 'p1' },
        { id: 'b3', outlineNodeId: 'on_2', order: 2, text: '背景段。', status: 'pending', versions: [], paragraphId: 'p2' },
      ],
      suggestions: [
        { id: 's1', blockId: 'b3', kind: 'ai_diff', instruction: null, proposed: '新背景段。', diff: [], state: 'pending', createdAt: '', scope: 'paragraph' },
        { id: 's2', blockId: 'b1', kind: 'ai_diff', instruction: null, proposed: 'x', diff: [], state: 'rejected', createdAt: '' },
      ],
    }
    const d = parseProjectFile(JSON.stringify(v1))
    expect(d.schema).toBe('suixin/project@2')
    expect(d).not.toHaveProperty('settings')
    expect(exportMarkdown(d)).toBe('# 旧文稿\n\n## 引言\n\n第一句。第二句。\n\n### 背景\n\n背景段。\n\n## 空章节\n')
    expect(d.suggestions).toHaveLength(1)
    expect(d.suggestions[0]).toMatchObject({ original: '背景段。', proposed: '新背景段。', state: 'pending' })
  })

  it('v1 迁移：没有正文的大纲节点留在原来的章节里', () => {
    const v1 = {
      schema: 'ai-writer/project@1',
      meta: { title: '稿', createdAt: '', updatedAt: '', language: 'zh' },
      outline: [
        {
          id: 'c1',
          title: '第一章',
          children: [
            { id: 'c11', title: '1.1', children: [] },
            { id: 'c12', title: '1.2', children: [] },
          ],
        },
        { id: 'c2', title: '第二章', children: [] },
      ],
      blocks: [
        { id: 'b1', outlineNodeId: 'c11', text: '一一。', paragraphId: 'p1' },
        { id: 'b2', outlineNodeId: 'c2', text: '二。', paragraphId: 'p2' },
      ],
      suggestions: [],
    }
    const d = parseProjectFile(JSON.stringify(v1))
    expect(exportMarkdown(d)).toBe('# 稿\n\n## 第一章\n\n### 1.1\n\n一一。\n\n### 1.2\n\n## 第二章\n\n二。\n')
  })
})

/** 帮助浮层：快捷键总表（spec §6.3 完整映射） */
import { useUIStore } from '../store/uiStore'
import { IconX } from './icons'

interface Group {
  title: string
  rows: [string, string][]
}

const GROUPS: Group[] = [
  {
    title: '粒度与导航',
    rows: [
      ['1 / 2 / 3', '句子 / 段落 / 全文粒度'],
      ['↑ / ↓', '上一块 / 下一块（最短距离露出）'],
      ['点击块', '选中（active）并显示浮动操作条'],
    ],
  },
  {
    title: '块级操作',
    rows: [
      ['E', '编辑当前块（Esc 取消 · Ctrl+Enter 确认）'],
      ['R', '提意见（自然语言指令 → AI 产出 diff）'],
      ['T', 'AI 重写（保持原意）'],
      ['Esc', '中断 AI 流式生成'],
    ],
  },
  {
    title: '内联 diff 确认',
    rows: [
      ['Tab', '在变更簇间跳转'],
      ['Y / N', '接受 / 拒绝当前簇'],
      ['Enter', '全部接受'],
      ['Esc', '全部拒绝'],
    ],
  },
  {
    title: '工程',
    rows: [
      ['Ctrl+S', '导出工程 JSON（自描述存档）'],
      ['Ctrl+Shift+S', '导出 Markdown'],
      ['Ctrl+Z / Ctrl+Shift+Z', '撤销 / 重做'],
      ['Ctrl+V', '空文档时直接粘贴导入'],
      ['?', '打开本帮助'],
    ],
  },
]

export function HelpOverlay() {
  const setHelpOpen = useUIStore((s) => s.setHelpOpen)

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setHelpOpen(false)
      }}
    >
      <div className="modal" style={{ width: 640 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div className="modal-title" style={{ marginBottom: 0 }}>
            快捷键与操作
          </div>
          <button
            className="icon-btn"
            onClick={() => setHelpOpen(false)}
            title="关闭（Esc）"
            aria-label="关闭"
          >
            <IconX />
          </button>
        </div>
        <div
          style={{
            marginTop: 16,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 20,
          }}
        >
          {GROUPS.map((g) => (
            <section key={g.title}>
              <div className="popover-title">{g.title}</div>
              <div className="kbd-table">
                {g.rows.map(([k, d]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <span style={{ justifySelf: 'start' }}>
                      <span className="kbd">{k}</span>
                    </span>
                    <span style={{ color: 'var(--text-secondary)' }}>{d}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
        <p
          style={{
            marginTop: 20,
            fontSize: 12,
            color: 'var(--text-tertiary)',
            lineHeight: 1.8,
          }}
        >
          设计原则：AI 永不直接改写正文——每一次产出都以内联 diff
          呈现，逐处确认后才写入版本历史。作者主权高于一切。
        </p>
      </div>
    </div>
  )
}

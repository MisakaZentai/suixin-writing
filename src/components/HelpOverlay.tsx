/** 帮助浮层：快捷键总表（spec §6.3 完整映射） */
import { isTauri } from '../lib/platform'
import { useUIStore } from '../store/uiStore'
import { IconX } from './icons'

interface Group {
  title: string
  rows: [string, string][]
}

const GROUPS: Group[] = [
  {
    title: '选择',
    rows: [
      ['点击 / ↑ ↓', '选中一段或一个标题'],
      ['Shift+点击 / Shift+↑ ↓', '连续选中多段'],
      ['鼠标划选', '选中段内的一段文字'],
      ['Esc', '逐层退出（关闭 → 取消选区 → 取消选中）'],
    ],
  },
  {
    title: '写作',
    rows: [
      ['E / Enter / 双击', '编辑（双击时光标落在点击处）'],
      ['Enter · Shift+Enter', '分段 · 段内换行'],
      ['段首 Backspace', '与上一段合并'],
      ['段首 ↑ · 段尾 ↓', '跨段继续编辑'],
      ['## 空格', '段落开头输入即转为标题'],
      ['Esc / 点击别处', '完成编辑'],
    ],
  },
  {
    title: 'Markdown（编辑时选中文字）',
    rows: [
      ['Ctrl+B · Ctrl+I', '加粗 · 斜体（再按一次取消）'],
      ['Ctrl+Shift+X · Ctrl+E', '删除线 · 行内代码'],
      ['Ctrl+K', '链接（选中地址直接输入）'],
      ['选中文字', '浮出格式栏：还有列表、有序列表、引用'],
    ],
  },
  {
    title: 'AI',
    rows: [
      ['空格 或 /', '对选中的内容唤起 AI'],
      ['直接回车', '润色（不写要求时）'],
      ['快捷指令', '精简 · 扩写 · 更口语 · 更正式 · 续写'],
      ['Esc', '生成中：中断'],
    ],
  },
  {
    title: '确认 AI 的修改',
    rows: [
      ['Tab / Shift+Tab', '在改动之间跳转'],
      ['Y / N', '接受 / 拒绝当前这处'],
      ['Enter', '全部接受'],
      ['Esc', '全部拒绝'],
    ],
  },
  {
    title: '文件',
    rows: [
      ['Ctrl+N · Ctrl+O', '新建 · 打开'],
      ['Ctrl+S', '保存（文稿随时自动保存）'],
      ['Ctrl+Shift+S', '另存为'],
      ['Ctrl+Shift+E', '导出 Markdown'],
      ['Ctrl+Z · Ctrl+Y', '撤销 · 重做'],
    ],
  },
  // 浏览器版用浏览器自己的缩放
  ...(isTauri
    ? [
        {
          title: '界面',
          rows: [['Ctrl+= · Ctrl+- · Ctrl+0', '放大 · 缩小 · 还原']] as [string, string][],
        },
      ]
    : []),
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
          AI 从不直接改动正文：每一次产出都先以对照形式呈现，由你逐处确认后才写入，
          并记入这一段的版本历史，随时可以恢复。
        </p>
      </div>
    </div>
  )
}

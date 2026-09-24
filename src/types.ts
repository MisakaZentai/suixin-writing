/**
 * 领域模型与工程文件 Schema（suixin/project@2）。
 *
 * 文档是一串有序的块：标题块与段落块。
 * - 段落是持久单位，每段有自己的版本历史；
 * - 大纲不单独存储，由标题块派生，永远和正文一致；
 * - 句子只在显示与 AI 选区时临时切分，不落盘。
 */

export type VersionSource =
  | 'import'
  | 'manual'
  | 'ai_rewrite'
  | 'ai_revise'
  | 'merge'
  | 'split'
  | 'rollback'
  | 'convert'
  /** 外部 agent 经授权直接修改 */
  | 'agent'

export interface Version {
  v: number
  text: string
  source: VersionSource
  /** AI 修改时的指令原文；回退时记录回退到的版本号，如 "v2" */
  instruction: string | null
  at: string
  /** 谁改的（agent 名称）；作者本人与内置 AI 为空 */
  author?: string
}

export interface HeadingBlock {
  id: string
  type: 'heading'
  /** 1–6，对应 Markdown 的 # 个数 */
  level: number
  text: string
  versions: Version[]
}

export interface ParagraphBlock {
  id: string
  type: 'paragraph'
  text: string
  versions: Version[]
}

export type DocBlock = HeadingBlock | ParagraphBlock

export type SuggestionKind =
  /** 待确认的 AI 修改 */
  | 'ai_diff'
  /** 检查建议：只描述问题与改法，不直接给出文本 */
  | 'note'

export type SuggestionState = 'pending' | 'accepted' | 'rejected'

export interface DiffOp {
  op: 'keep' | 'del' | 'ins'
  text: string
}

/**
 * 建议的作用目标，三选一：
 * - blockIds 非空、无 range：替换这些连续段落；
 * - blockIds 只有一个且有 range：替换段内 [start, end) 片段；
 * - blockIds 为空：在 insertAfter 之后插入新段落（null 表示文首）。
 */
export interface SuggestionTarget {
  blockIds: string[]
  range?: [number, number] | null
  insertAfter?: string | null
}

export interface Suggestion {
  id: string
  kind: SuggestionKind
  target: SuggestionTarget
  /** 用户意见 / 检查建议原文；纯润色重写为 null */
  instruction: string | null
  /** 生成时目标位置的原文（用于判断建议是否已过期） */
  original: string
  /** 当前候选文本（note 类为空字符串） */
  proposed: string
  /** 多个候选（"再来一版"），proposed 始终是其中之一 */
  candidates?: string[]
  /** original → proposed 的操作流，供外部 agent 直接阅读 */
  diff: DiffOp[]
  state: SuggestionState
  createdAt: string
  /** note 类：发现的问题 */
  issue?: string
  /** 生成方式，"再来一版"时据此重新请求 */
  task?: SuggestionTask
  /** 外部 agent 提出的建议：署名、理由与所属变更集 */
  author?: SuggestionAuthor
  why?: string
  changeset?: string
}

export interface SuggestionAuthor {
  kind: 'agent'
  name: string
}

export type SuggestionTask = 'rewrite' | 'revise' | 'continue' | 'expand' | 'deflavor'

export interface ProjectMeta {
  title: string
  createdAt: string
  updatedAt: string
  language: string
  /** 导出 Markdown 时是否把标题写成文首的一级标题（导入的文本原本没有标题时为 false） */
  titleAsHeading?: boolean
  /**
   * 外部 agent 的权限：propose = 只能提建议（默认）；direct = 作者已授权直接修改。
   * 只能由作者在 App 里修改。
   */
  agentAccess?: AgentAccess
  /** AI 味检查的设置（见 docs/AI味方案.md） */
  flavor?: FlavorSettings
}

export type AgentAccess = 'propose' | 'direct'

export interface FlavorSettings {
  /** 文体；不填则按对白占比自动判断 */
  genre?: 'fiction' | 'essay' | 'general'
  /** 作者确认"这处没问题"的命中：`规则id:原文` */
  ignore?: string[]
  /** 选用的个人基线名 */
  baseline?: string
}

/**
 * 作者"交给 Agent"的任务：选中一处、写下要求，等外部 agent 接手。
 * agent 接手（claimed）后照常提建议，做完标记 done 并留一句说明。
 */
export interface AgentTask {
  id: string
  instruction: string
  /** 作用位置，含义同建议的 target；blockIds 为空时 insertAfter 指向还没有正文的那一节标题 */
  target: SuggestionTarget
  /** 交办时那处的原文，供 agent 定位与判断是否已变 */
  quote: string
  /** 所在章节路径，如 "第二章 / 引言" */
  section?: string
  state: AgentTaskState
  createdAt: string
  claimedBy?: string
  claimedAt?: string
  doneAt?: string
  /** agent 完成时的说明 */
  summary?: string
}

export type AgentTaskState = 'open' | 'claimed' | 'done' | 'cancelled'

export const PROJECT_SCHEMA = 'suixin/project@2'

export interface ProjectData {
  schema: typeof PROJECT_SCHEMA
  meta: ProjectMeta
  blocks: DocBlock[]
  suggestions: Suggestion[]
  /** 写作设定：读者、语气、禁用词等，随每次 AI 请求发送 */
  brief?: string
  /** 交给 Agent 的任务（旧文件没有这个字段） */
  tasks?: AgentTask[]
}

/** 由标题块派生的大纲节点（id 即标题块 id） */
export interface OutlineNode {
  id: string
  title: string
  level: number
  children: OutlineNode[]
}

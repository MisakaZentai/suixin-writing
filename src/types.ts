/**
 * 领域模型与工程 JSON Schema（对应 spec.md §3 / §5，schema: ai-writer/project@1）
 */

/** 块状态机：clean | active | pending | dirty（spec §3.1） */
export type BlockStatus = 'clean' | 'active' | 'pending' | 'dirty'

/** 版本来源 */
export type VersionSource =
  | 'import'
  | 'manual'
  | 'ai_rewrite'
  | 'ai_revise'
  | 'merge'
  | 'split'

export interface Version {
  v: number
  text: string
  source: VersionSource
  instruction: string | null
  at: string
}

/**
 * 底层块（句子级原子单元）。
 * 段落/全文粒度是对相邻同 paragraphId 块的聚合视图（spec §3.2）。
 */
export interface Block {
  id: string
  outlineNodeId: string | null
  order: number
  text: string
  status: BlockStatus
  versions: Version[]
  paragraphId: string
}

export interface OutlineNode {
  id: string
  title: string
  children: OutlineNode[]
}

export type SuggestionKind = 'ai_diff' | 'alignment'
export type SuggestionState = 'pending' | 'accepted' | 'rejected'

export interface DiffOp {
  op: 'keep' | 'del' | 'ins'
  text: string
}

export interface Suggestion {
  id: string
  blockId: string
  kind: SuggestionKind
  instruction: string | null
  proposed: string
  diff: DiffOp[]
  state: SuggestionState
  createdAt: string
  /** 扩展字段：该 diff 产生时的粒度（决定接受时替换的范围） */
  scope?: 'full' | 'paragraph' | 'sentence'
}

export interface ProjectMeta {
  title: string
  createdAt: string
  updatedAt: string
  language: string
}

export interface ProjectSettings {
  model: string
  baseURL: string
  temperature: number
}

export interface ProjectData {
  schema: 'ai-writer/project@1'
  meta: ProjectMeta
  settings: ProjectSettings
  outline: OutlineNode[]
  blocks: Block[]
  suggestions: Suggestion[]
}

export type Granularity = 'sentence' | 'paragraph' | 'full'

/** 计算得到的“显示块”（当前粒度下的编辑/AI 单元） */
export interface DisplayBlock {
  key: string
  blockIds: string[]
  text: string
  versions: Version[]
  status: BlockStatus
  outlineNodeId: string | null
  /** 大纲节点路径（根 → 当前），用于 AI 上下文与 UI 提示 */
  outlinePath: OutlineNode[]
}

/** 大纲节点 + 祖先路径 */
export interface OutlineNodeWithPath {
  node: OutlineNode
  path: OutlineNode[]
}

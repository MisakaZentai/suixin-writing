/**
 * "交给 Agent"：把 AI 指令框里的要求连同选区交给外部 agent，而不是内置 AI。
 * 任务存在文稿里，agent 连上后（实时桥或读文件）就能看到。
 */
import type { SuggestionTarget } from '../types'
import { getBlock, headingPaths, targetText } from '../lib/doc'
import { useProjectStore } from './projectStore'
import { useUIStore } from './uiStore'
import { useBridgeStore } from './bridgeStore'

export function handPromptToAgent(): string | null {
  const ui = useUIStore.getState()
  const prompt = ui.aiPrompt
  const data = useProjectStore.getState().data
  const instruction = prompt?.draft.trim()
  if (!prompt || !data || !instruction) return null
  const scope = prompt.scope
  const target: SuggestionTarget =
    scope.kind === 'range'
      ? { blockIds: scope.blockIds, range: scope.range ?? null }
      : scope.blockIds.length
        ? { blockIds: scope.blockIds }
        : { blockIds: [], insertAfter: scope.headingId ?? scope.anchorId }
  const heading = scope.headingId ? getBlock(data, scope.headingId) : undefined
  const trail = (headingPaths(data.blocks).get(scope.headingId ?? scope.anchorId) ?? []).map((h) => h.text)
  if (heading) trail.push(heading.text)
  const quote = scope.kind === 'range' ? scope.preview ?? '' : (target.blockIds.length ? targetText(data, target) : '') ?? ''
  const id = useProjectStore.getState().addTask({
    instruction,
    target,
    quote,
    ...(trail.length ? { section: trail.join(' / ') } : {}),
  })
  if (!id) return null
  ui.closeAIPrompt()
  const online = useBridgeStore.getState().agents.map((a) => a.name)
  ui.pushToast({
    kind: 'success',
    text: online.length ? `已交给 Agent（${online.join('、')} 在线）` : '已交给 Agent：agent 连上后就能看到，进度在待办里',
    actionLabel: '查看',
    onAction: () => useUIStore.getState().setSuggestionsOpen(true),
    duration: 5000,
  })
  return id
}

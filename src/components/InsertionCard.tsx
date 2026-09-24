/** 插入型生成内容（续写 / 扩写空章节）的落点：生成中显示打字机，完成后显示 diff */
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { DiffView } from './DiffView'
import { StreamView } from './StreamView'
import { abortAI } from '../store/aiActions'
import { isImageText } from '../lib/images'

export function InsertionCard() {
  const stream = useUIStore((s) => (s.stream?.insert ? s.stream : null))
  const diff = useUIStore((s) => (s.diff?.insert ? s.diff : null))
  const suggestion = useProjectStore((s) =>
    diff ? s.data?.suggestions.find((x) => x.id === diff.suggestionId) : undefined
  )

  if (!stream && !(diff && suggestion)) return null
  return (
    <div className="block active insertion">
      <span className="block-anchor" />
      <div className="insertion-label">
        {suggestion?.author
          ? `${suggestion.author.name} ${suggestion.proposed.split(/\n{2,}/).some(isImageText) ? '插入的图片' : '新写的内容'}`
          : 'AI 新写的内容'}
      </div>
      {stream ? (
        <StreamView tw={stream.tw} onAbort={abortAI} />
      ) : (
        <DiffView ops={suggestion!.diff} suggestion={suggestion!} diff={diff!} />
      )}
    </div>
  )
}

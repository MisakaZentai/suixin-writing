/** 图片段落的显示：图片 + 图注；图片找不到时给出路径，方便排查 */
import { useEffect, useState } from 'react'
import { useDocsStore } from '../store/docsStore'
import { imageUrl } from '../store/imageActions'

export function ImageFigure({ src, caption, showEmptyCaption }: { src: string; caption: string; showEmptyCaption?: boolean }) {
  // 文稿换了位置（另存为）时重新解析路径
  const docKey = useDocsStore((s) => `${s.current?.id}|${s.current?.path}`)
  const [state, setState] = useState<{ url: string | null; loading: boolean }>({ url: null, loading: true })

  useEffect(() => {
    let alive = true
    setState({ url: null, loading: true })
    imageUrl(src)
      .catch(() => null)
      .then((url) => alive && setState({ url, loading: false }))
    return () => {
      alive = false
    }
  }, [src, docKey])

  return (
    <figure className="block-figure">
      {state.url ? (
        <img src={state.url} alt={caption} draggable={false} />
      ) : (
        <div className="figure-missing" role="img" aria-label={caption || '图片'}>
          {state.loading ? '正在载入图片…' : `找不到图片：${src}`}
        </div>
      )}
      {caption ? (
        <figcaption>{caption}</figcaption>
      ) : (
        showEmptyCaption && <figcaption className="placeholder">没有图注 · 按 E 添加</figcaption>
      )}
    </figure>
  )
}

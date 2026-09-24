/**
 * 发布到知乎：逐段复制，到知乎编辑器里粘贴。文字以富文本复制（标题、加粗、列表等都在），
 * 图片以 PNG 复制，由知乎自己上传。作者自己发，或让 agent 用 computer use 照着点。
 * 能在浏览器里执行脚本的 agent 用命令行生成的发布包更省事（见下方）。
 */
import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useBridgeStore } from '../store/bridgeStore'
import { renderParts, type RenderPart } from '../lib/render'
import { zhihuHtml } from '../lib/zhihu'
import { readAsset } from '../lib/assets'
import { isRemote, mimeOf } from '../lib/images'
import { currentAssetCtx } from '../store/imageActions'
import { toRenderDoc } from '../store/exportActions'
import { IconCheck, IconX } from './icons'

const WRITE_URL = 'https://zhuanlan.zhihu.com/write'

type Step = { kind: 'title'; text: string } | RenderPart

function plain(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return (div.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** 剪贴板只收 PNG：其他格式先画到画布上转一下 */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('转换图片失败'))), 'image/png'))
}

async function imageBlob(src: string): Promise<Blob | null> {
  if (isRemote(src)) {
    const res = await fetch(src).catch(() => null)
    return res?.ok ? res.blob() : null
  }
  const ctx = currentAssetCtx()
  const bytes = ctx ? await readAsset(ctx, src) : null
  return bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeOf(src) }) : null
}

export function PublishModal() {
  const data = useProjectStore((s) => s.data)
  const bridgeOnline = useBridgeStore((s) => s.online)
  const [steps, setSteps] = useState<Step[] | null>(null)
  const [done, setDone] = useState<Set<number>>(new Set())
  const close = () => useUIStore.getState().setPublishOpen(false)
  const toast = (kind: 'success' | 'error' | 'info', text: string) => useUIStore.getState().pushToast({ kind, text })

  useEffect(() => {
    if (!data) return
    let alive = true
    void renderParts(toRenderDoc(data), { includeTitle: false, image: async (src) => src }).then((parts) => {
      if (!alive) return
      setSteps([{ kind: 'title', text: data.meta.title }, ...parts.map((p) => (p.kind === 'html' ? { ...p, html: zhihuHtml(p.html) } : p))])
      setDone(new Set())
    })
    return () => {
      alive = false
    }
  }, [data])

  const copy = async (i: number, step: Step) => {
    try {
      if (step.kind === 'title') await navigator.clipboard.writeText(step.text)
      else if (step.kind === 'html') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([step.html], { type: 'text/html' }),
            'text/plain': new Blob([plain(step.html)], { type: 'text/plain' }),
          }),
        ])
      } else {
        const blob = await imageBlob(step.src)
        if (!blob) throw new Error(`找不到图片 ${step.src}`)
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': await asPng(blob) })])
      }
      setDone((d) => new Set(d).add(i))
      toast('success', step.kind === 'image' ? '已复制图片，到知乎粘贴（它会自动上传）' : '已复制，到知乎粘贴')
    } catch (e) {
      toast('error', `复制失败：${(e as Error).message}`)
    }
  }
  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text)
    toast('info', '已复制')
  }

  const command = `suixin export ${bridgeOnline ? '@' : '稿子.suixin.json'} --format zhihu -o 知乎发布包`

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="modal publish-modal" role="dialog" aria-label="发布到知乎">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>
            发布到知乎
          </div>
          <button className="icon-btn" onClick={close} title="关闭（Esc）" aria-label="关闭">
            <IconX />
          </button>
        </div>
        <p className="modal-desc">
          打开知乎「写文章」（<code>{WRITE_URL}</code>
          <button className="link-btn" onClick={() => copyText(WRITE_URL)}>
            复制链接
          </button>
          ），按顺序逐段复制、粘贴。图片粘贴后由知乎自动上传，图注在图片下方的"添加图片注释"里填。
        </p>
        <ol className="publish-steps">
          {steps?.map((step, i) => (
            <li key={i} className={done.has(i) ? 'done' : ''}>
              <span className="publish-step-what">
                {step.kind === 'title' ? (
                  <>
                    <b>标题</b> {step.text}
                  </>
                ) : step.kind === 'html' ? (
                  <>
                    <b>文字</b> {plain(step.html).slice(0, 40)}
                    {plain(step.html).length > 40 ? '…' : ''}
                  </>
                ) : (
                  <>
                    <b>图片</b> {step.caption ? `图注：${step.caption}` : '（没有图注）'}
                  </>
                )}
              </span>
              {step.kind === 'image' && step.caption && (
                <button className="link-btn" onClick={() => copyText(step.caption)}>
                  复制图注
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => void copy(i, step)}>
                {done.has(i) && <IconCheck size={12} />}
                {step.kind === 'image' ? '复制图片' : '复制'}
              </button>
            </li>
          ))}
        </ol>
        <div className="settings-section-title" style={{ marginTop: 16 }}>
          让 agent 来发
        </div>
        <p className="settings-hint">
          能在浏览器里执行脚本的 agent（如 Claude in Chrome）可以先生成发布包：
          <code className="agent-example">{command}</code>
          <button className="link-btn" onClick={() => copyText(command)}>
            复制
          </button>
          ，再在已登录的知乎写文章页执行包里的 publish.js：内容与图片会按顺序填进草稿。脚本不会点"发布"，发不发由你决定。
        </p>
      </div>
    </div>
  )
}

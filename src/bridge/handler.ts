/**
 * 实时桥的 App 端：agent 的请求在作者眼前的这份文稿上执行。
 *
 * 与直接读写文件相比：
 * - 建议立即出现，不用等轮询；读到的是 App 里的最新内容（含还没落盘的改动）；
 * - 权限以 App 为准（不看文件里的字段），也可以当场请作者授权；
 * - 直接修改不会动作者正在编辑的那一段。
 * 执行后照常自动保存，绑定了文件的同时写回文件。
 */
import type { DocBlock, ProjectData } from '../types'
import { runOps, type OpCall } from '../agent/run'
import { AgentError, toAgentError } from '../agent/errors'
import { countChars, getBlock, headingPaths } from '../lib/doc'
import { isActive, tasksOf } from '../lib/tasks'
import { summarize } from '../lib/sync'
import { useProjectStore } from '../store/projectStore'
import { useDocsStore } from '../store/docsStore'
import { resolveScope, useUIStore } from '../store/uiStore'
import { useBridgeStore } from '../store/bridgeStore'
import type { BridgeRequest, BridgeResponse, DocRef } from './protocol'
import { assetPath, assetsDirName, putAsset, readAsset, type AssetCtx } from '../lib/assets'
import { annotateImages, contentName, imageSize, isRemote, sniffExt } from '../lib/images'

const project = () => useProjectStore.getState()
const docs = () => useDocsStore.getState()
const ui = () => useUIStore.getState()

export function docRef(): DocRef | null {
  const cur = docs().current
  const data = project().data
  if (!cur || !data) return null
  return { id: cur.id, title: data.meta.title, path: cur.path }
}

/** 同一个文件的两种写法：Windows 下不分大小写、斜杠方向 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const x = norm(a)
  const y = norm(b)
  return /^[a-z]:\//i.test(x) || /^[a-z]:\//i.test(y) ? x.toLowerCase() === y.toLowerCase() : x === y
}

/* ── 选区 ─────────────────────────────────────────── */

export interface SelectionView {
  kind: 'paragraphs' | 'range' | 'section'
  label: string
  text: string
  blocks: { id: string; type: DocBlock['type']; text: string }[]
  range?: [number, number]
  section?: string
  /** 可以直接用在 replace / note 等操作里的定位 */
  target: Record<string, unknown>
}

export function selectionView(): SelectionView | null {
  const data = project().data
  const scope = data ? resolveScope() : null
  if (!data || !scope || 'error' in scope) return null
  const blocks = scope.blockIds.map((id) => getBlock(data, id)).filter((b): b is DocBlock => !!b)
  const paths = headingPaths(data.blocks)
  const heading = scope.headingId ? getBlock(data, scope.headingId) : undefined
  const trail = (paths.get(scope.headingId ?? scope.anchorId) ?? []).map((h) => h.text)
  if (heading) trail.push(heading.text)
  const text = scope.kind === 'range' ? scope.preview ?? '' : blocks.map((b) => b.text).join('\n\n')
  const target =
    scope.kind === 'range'
      ? { quote: text, in: scope.blockIds[0] }
      : scope.kind === 'section'
        ? { section: scope.headingId }
        : scope.blockIds.length === 1
          ? { block: scope.blockIds[0] }
          : { blocks: scope.blockIds }
  return {
    kind: scope.kind,
    label: scope.label,
    text,
    blocks: blocks.map((b) => ({ id: b.id, type: b.type, text: b.text })),
    ...(scope.range ? { range: scope.range } : {}),
    ...(trail.length ? { section: trail.join(' / ') } : {}),
    target,
  }
}

/* ── 方法 ─────────────────────────────────────────── */

function status() {
  const data = project().data
  return {
    app: '随心写作',
    document: docRef(),
    ...(data
      ? {
          access: data.meta.agentAccess ?? 'propose',
          paragraphs: data.blocks.filter((b) => b.type === 'paragraph').length,
          chars: data.blocks.reduce((n, b) => n + (b.type === 'paragraph' ? countChars(b.text) : 0), 0),
          pending: data.suggestions.filter((s) => s.state === 'pending').length,
          tasks: tasksOf(data).filter(isActive).length,
          selection: selectionView(),
          // 作者正在写的那一段：别直接改它
          editing: ui().editing?.id ?? null,
        }
      : {}),
    // 作者是否正看着 App（窗口在前台）
    focused: typeof document !== 'undefined' ? document.hasFocus() : false,
  }
}

function requireDocument(): { data: ProjectData; ref: DocRef } {
  const data = project().data
  const ref = docRef()
  if (!data || !ref) {
    throw new AgentError('NOT_FOUND', 'App 里没有打开的文稿', '请作者先打开文稿，或给出 .suixin.json 文件路径')
  }
  return { data, ref }
}

/** 哪些段落的文字变了（直接修改时用来避开作者正在编辑的段落） */
function changedBlockIds(before: ProjectData, after: ProjectData): Set<string> {
  const old = new Map(before.blocks.map((b) => [b.id, b.text]))
  const out = new Set<string>()
  for (const b of after.blocks) if (old.get(b.id) !== b.text) out.add(b.id)
  for (const id of old.keys()) if (!after.blocks.some((b) => b.id === id)) out.add(id)
  return out
}

/** 请求指的是不是 App 里打开的这篇（file 省略或为 @ 即是） */
function targetsCurrent(params: Record<string, unknown>): boolean {
  const file = typeof params.file === 'string' && params.file.trim() && params.file !== '@' ? params.file : null
  const cur = docs().current
  return !file || !!(cur?.path && samePath(cur.path, file))
}

function assetCtx(ref: DocRef): AssetCtx {
  return { docId: ref.id, path: ref.path }
}

/** 给结果里的图片补上绝对路径（桌面版）、尺寸与大小 */
function appImageInfo(ctx: AssetCtx) {
  return async (src: string): Promise<Record<string, unknown>> => {
    if (isRemote(src)) return { remote: true }
    const [path, bytes] = await Promise.all([assetPath(ctx, src), readAsset(ctx, src)])
    if (!bytes) return { ...(path ? { path } : {}), exists: false }
    return { ...(path ? { path } : {}), exists: true, bytes: bytes.length, ...(imageSize(bytes) ?? {}) }
  }
}

async function putAssetFromAgent(params: Record<string, unknown>) {
  if (!targetsCurrent(params)) return { handled: false }
  const { ref } = requireDocument()
  if (typeof params.data !== 'string') throw new AgentError('INVALID_PARAMS', 'data 应为 base64 编码的图片')
  const bytes = Uint8Array.from(atob(params.data), (c) => c.charCodeAt(0))
  const ext = (typeof params.ext === 'string' && params.ext) || sniffExt(bytes) || 'png'
  const ctx = assetCtx(ref)
  const src = params.dryRun === true ? `${assetsDirName(ctx)}/${await contentName(bytes, ext)}` : await putAsset(ctx, bytes, ext)
  return { handled: true, src }
}

async function readAssetForAgent(params: Record<string, unknown>) {
  if (!targetsCurrent(params)) return { handled: false }
  const { ref } = requireDocument()
  if (typeof params.src !== 'string') throw new AgentError('INVALID_PARAMS', '需要 src')
  const ctx = assetCtx(ref)
  const bytes = await readAsset(ctx, params.src)
  if (!bytes) throw new AgentError('NOT_FOUND', `图片不存在：${params.src}`)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { handled: true, data: btoa(binary), path: await assetPath(ctx, params.src) }
}

async function operate(params: Record<string, unknown>, agent: string) {
  // 指定了文件但 App 开着的不是它：告诉命令行自己去读写文件
  if (!targetsCurrent(params)) return { handled: false }
  const { data, ref } = requireDocument()
  if (!Array.isArray(params.calls)) throw new AgentError('INVALID_PARAMS', 'calls 应为操作数组')
  if (docs().external) {
    throw new AgentError('CONFLICT', '作者正在处理这篇文稿的外部修改冲突', '稍后重试')
  }
  const direct = params.direct === true
  const dryRun = params.dryRun === true
  const r = runOps(data, params.calls as OpCall[], { author: agent, direct })
  if (!r.ok) {
    const err = new AgentError(r.error.code, r.error.message, r.error.hint, r.error.candidates)
    throw Object.assign(err, { index: r.index })
  }
  const written = r.changed && !dryRun
  if (written) {
    const editing = ui().editing
    if (editing && r.mode === 'direct' && changedBlockIds(data, r.data).has(editing.id)) {
      throw new AgentError('CONFLICT', '作者正在编辑这一段', '换一处，或改用提建议（去掉 direct）')
    }
    project().replaceFromExternal(r.data)
    if (r.mode === 'direct') {
      // 直接修改没有经过作者确认：说清楚，并给一个撤销的机会
      ui().pushToast({
        kind: 'info',
        text: `${agent} 直接修改了这篇文稿`,
        actionLabel: '撤销',
        onAction: () => project().undo(),
        duration: 8000,
      })
    } else {
      const summary = summarize(data, r.data)
      ui().pushToast({
        kind: 'info',
        text: summary.includes(agent) ? summary : `${agent}：${summary}`,
        actionLabel: '查看',
        onAction: () => ui().setSuggestionsOpen(true),
        duration: 5000,
      })
    }
  }
  // 写入已经同步完成；补图片信息要读文件，放在最后
  await annotateImages(r.results, appImageInfo(assetCtx(ref)))
  return {
    handled: true,
    ok: true,
    via: 'app',
    file: ref.path,
    document: ref.title,
    mode: r.mode,
    changeset: r.changeset,
    results: r.results,
    written,
    ...(dryRun ? { dryRun: true } : {}),
  }
}

async function requestAccess(params: Record<string, unknown>, agent: string) {
  const { data, ref } = requireDocument()
  if (data.meta.agentAccess === 'direct') return { granted: true, already: true }
  const reason = typeof params.reason === 'string' ? params.reason.trim().slice(0, 300) : ''
  const granted = await useBridgeStore.getState().askAccess({ agent, reason, docId: ref.id, title: ref.title })
  // 作者回应前切到了别的文稿：不算数
  const stillHere = docs().current?.id === ref.id
  if (granted && stillHere) project().setAgentAccess('direct')
  return { granted: granted && stillHere }
}

export async function handleBridgeRequest(req: BridgeRequest): Promise<BridgeResponse> {
  const agent = req.agent?.trim() || 'Agent'
  const params = req.params ?? {}
  try {
    switch (req.method) {
      case 'app.status':
        return { ok: true, result: status() }
      case 'doc.selection':
        return { ok: true, result: { document: docRef(), selection: selectionView() } }
      case 'doc.operate':
        return { ok: true, result: await operate(params, agent) }
      case 'access.request':
        return { ok: true, result: await requestAccess(params, agent) }
      case 'asset.put':
        return { ok: true, result: await putAssetFromAgent(params) }
      case 'asset.read':
        return { ok: true, result: await readAssetForAgent(params) }
      default:
        throw new AgentError('UNSUPPORTED', `App 不支持 ${req.method}`, '升级随心写作后再试')
    }
  } catch (e) {
    const index = (e as { index?: number }).index
    return { ok: false, error: toAgentError(e).toJSON(), ...(index !== undefined ? { index } : {}) }
  }
}

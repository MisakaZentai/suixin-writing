/** 命令行与 MCP 共用的工程文件读写：原子写入，写前比对，被改过就基于新内容重来 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectData } from '../src/types'
import { PROJECT_FILE_SUFFIX, parseProjectFile, serializeProject } from '../src/lib/project'
import { runOps, type OpCall } from '../src/agent/run'
import { AgentError } from '../src/agent/errors'
import { BridgeOffline, offlineError, type BridgeClient } from './bridge'
import { annotateImages, imageSize, isRemote } from '../src/lib/images'

export async function loadProject(file: string): Promise<{ data: ProjectData; raw: string }> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    throw new AgentError('NOT_FOUND', `打不开文件 ${file}`, '用 suixin new 新建，或检查路径')
  }
  if (!/\.json$/i.test(file)) {
    throw new AgentError('UNSUPPORTED', '只能直接修改工程文件（.suixin.json）', `先用 suixin new 稿子${PROJECT_FILE_SUFFIX} --from ${path.basename(file)} 转换`)
  }
  try {
    return { data: parseProjectFile(raw), raw }
  } catch (e) {
    throw new AgentError('UNSUPPORTED', (e as Error).message)
  }
}

/** 原子写入：先写临时文件再改名，避免作者的 App 读到写了一半的文件 */
export async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, file)
}

export interface OperateOptions {
  author: string
  direct?: boolean
  dryRun?: boolean
  /** 实时桥；为 null 时只读写文件 */
  bridge?: BridgeClient | null
}

/** 文件参数写成 @ 表示"App 里正在打开的那篇" */
export const CURRENT_DOC = '@'

/**
 * 执行操作：App 开着且正打开这篇（或 file 为 @ / 省略）时交给 App，
 * 建议立即出现在作者眼前；否则直接读写文件。
 * App 回复的错误（如未授权）原样抛出，不退回文件——那样会绕过作者的决定。
 */
export async function operate(file: string | null, calls: OpCall[], opts: OperateOptions) {
  if (opts.bridge) {
    try {
      const r = (await opts.bridge.call('doc.operate', {
        file,
        calls,
        direct: !!opts.direct,
        dryRun: !!opts.dryRun,
      })) as { handled: boolean } & Record<string, unknown>
      if (r.handled) {
        const { handled: _handled, ...rest } = r
        return rest
      }
    } catch (e) {
      if (!(e instanceof BridgeOffline)) throw e
      if (!file) throw offlineError()
    }
  }
  if (!file) throw offlineError()
  return operateOnFile(file, calls, opts)
}

/** 图片的绝对路径：相对于工程文件所在目录 */
export function assetFile(file: string, src: string): string {
  return path.resolve(path.dirname(file), ...src.split('/'))
}

/** 给结果里的图片补上绝对路径、尺寸、大小（文件模式） */
export function fileImageInfo(file: string) {
  return async (src: string): Promise<Record<string, unknown>> => {
    if (isRemote(src)) return { remote: true }
    const abs = assetFile(file, src)
    const bytes = await fs.readFile(abs).catch(() => null)
    if (!bytes) return { path: abs, exists: false }
    return { path: abs, exists: true, bytes: bytes.length, ...(imageSize(bytes) ?? {}) }
  }
}

export async function operateOnFile(file: string, calls: OpCall[], opts: OperateOptions) {
  // 读 → 执行 → 写之前确认文件没被别人（比如作者的 App）改过；改过就基于新内容重来一次
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, raw } = await loadProject(file)
    const r = runOps(data, calls, { author: opts.author, direct: !!opts.direct })
    if (!r.ok) throw Object.assign(new AgentError(r.error.code, r.error.message, r.error.hint, r.error.candidates), { index: r.index })
    await annotateImages(r.results, fileImageInfo(file))
    const out = { ok: true as const, file, mode: r.mode, changeset: r.changeset, results: r.results }
    if (!r.changed || opts.dryRun) return { ...out, written: false, ...(opts.dryRun ? { dryRun: true } : {}) }
    const now = await fs.readFile(file, 'utf8')
    if (now !== raw) continue
    await writeAtomic(file, serializeProject(r.data))
    return { ...out, written: true }
  }
  throw new AgentError('CONFLICT', '文件在这期间被反复修改，未写入', '稍后重试')
}

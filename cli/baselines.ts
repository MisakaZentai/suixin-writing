/**
 * 命令行 / MCP 这一端的 AI 味个人基线：与 App 共用应用数据目录里的 flavor-baselines.json。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  analyzeDocument,
  BASELINE_FILE,
  baselineFromSources,
  MIN_BASELINE_CHARS,
  parseBaselineStore,
  removeBaseline,
  serializeBaselineStore,
  setBaselineStore,
  setDefaultBaseline,
  sourceParagraphs,
  upsertBaseline,
  type BaselineStore,
} from '../src/lib/flavor'
import { AgentError } from '../src/agent/errors'
import { appDataFile } from './bridge'

type Env = Record<string, string | undefined>

export function baselinePath(env: Env): string | null {
  return env.SUIXIN_BASELINES || appDataFile(env, BASELINE_FILE)
}

export async function readBaselines(env: Env): Promise<BaselineStore> {
  const file = baselinePath(env)
  const text = file ? await fs.readFile(file, 'utf8').catch(() => null) : null
  return parseBaselineStore(text)
}

/** 启动时载入，之后的 AI 味检查按文稿的选择 / 默认基线计算 */
export async function loadBaselines(env: Env): Promise<void> {
  setBaselineStore(await readBaselines(env))
}

async function writeBaselines(env: Env, store: BaselineStore): Promise<string> {
  const file = baselinePath(env)
  if (!file) throw new AgentError('UNAVAILABLE', '找不到应用数据目录', '设置环境变量 SUIXIN_BASELINES 指定基线文件的位置')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, serializeBaselineStore(store), 'utf8')
  await fs.rename(tmp, file)
  setBaselineStore(store)
  return file
}

function summary(store: BaselineStore) {
  return store.baselines.map((b) => ({
    name: b.name,
    chars: b.chars,
    default: store.default === b.name || undefined,
    builtFrom: b.builtFrom,
    createdAt: b.createdAt,
    counts: b.counts,
  }))
}

/** suixin baseline list | build | default | remove */
export async function baselineCommand(args: string[], flags: { default?: boolean }, env: Env, cwd: string) {
  const [sub = 'list', name, ...files] = args
  const store = await readBaselines(env)
  switch (sub) {
    case 'list':
      return { ok: true, file: baselinePath(env), default: store.default ?? '内置', baselines: summary(store) }
    case 'build': {
      if (!name || !files.length) throw new AgentError('INVALID_PARAMS', '用法：suixin baseline build <名字> <作者原文…> [--default]')
      if (name === '内置') throw new AgentError('INVALID_PARAMS', '"内置"是保留的名字')
      const sources = await Promise.all(
        files.map(async (f) => ({ name: path.basename(f), text: await fs.readFile(path.resolve(cwd, f), 'utf8') }))
      )
      const baseline = baselineFromSources(name, sources)
      // 预检：来源本身 AI 味很重，基线会把套路当成作者的习惯
      const paras = sources.flatMap((s) => sourceParagraphs(s.name, s.text))
      const check = analyzeDocument(
        paras.map((text, i) => ({ id: `s${i}`, type: 'paragraph' as const, text })),
        { baseline: null }
      )
      const file = await writeBaselines(env, upsertBaseline(store, baseline, !!flags.default || !store.baselines.length))
      const warnings = [
        baseline.chars < MIN_BASELINE_CHARS ? `只有 ${baseline.chars} 字，统计可能不准（建议 ${MIN_BASELINE_CHARS} 字以上）` : '',
        (check.index ?? 0) >= 35 ? `这些文字本身的 AI 味指数是 ${check.index}（${check.level}），用作基线会把其中的套路当成作者习惯` : '',
      ].filter(Boolean)
      return { ok: true, file, name, chars: baseline.chars, counts: baseline.counts, ...(warnings.length ? { warnings } : {}) }
    }
    case 'default': {
      if (!name) throw new AgentError('INVALID_PARAMS', '用法：suixin baseline default <名字|内置>')
      if (name !== '内置' && !store.baselines.some((b) => b.name === name)) throw new AgentError('NOT_FOUND', `没有基线「${name}」`)
      const file = await writeBaselines(env, setDefaultBaseline(store, name))
      return { ok: true, file, default: name }
    }
    case 'remove': {
      if (!name || !store.baselines.some((b) => b.name === name)) throw new AgentError('NOT_FOUND', `没有基线「${name ?? ''}」`)
      const file = await writeBaselines(env, removeBaseline(store, name))
      return { ok: true, file, removed: name }
    }
    default:
      throw new AgentError('INVALID_PARAMS', `未知的子命令 ${sub}`, '可用：list、build、default、remove')
  }
}

/**
 * suixin —— 随心写作的无头命令行，给 Codex / Claude Code / Kimi Code 等 agent 使用。
 * 所有命令输出 JSON（export / read --markdown 除外），失败时退出码非 0。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { exportMarkdown, projectFromText, serializeProject } from '../src/lib/project'
import type { OpCall } from '../src/agent/run'
import { CURRENT_DOC, loadProject, operate as operateVia, writeAtomic } from './files'
import { BridgeOffline, callOnline, connectBridge, requireBridge } from './bridge'
import type { BridgeMethod } from '../src/bridge/protocol'
import { addImage, loadImageSource, readImage } from './images'
import { exportMarkdownWithImages, exportPdf, exportZhihu, loadForRender, parseStyle, renderPngPages, selfContainedHtml } from './render'
import os from 'node:os'
import { imageSize } from '../src/lib/images'
import { describeOps } from '../src/agent/ops'
import { AGENT_GUIDE } from '../src/agent/guide'
import { AgentError, toAgentError } from '../src/agent/errors'
import type { TargetSpec } from '../src/agent/target'
import { baselineCommand, loadBaselines } from './baselines'

export interface CliIO {
  stdout: (text: string) => void
  stderr: (text: string) => void
  readStdin: () => Promise<string>
  env: Record<string, string | undefined>
  cwd: string
}

const USAGE = `suixin —— 随心写作命令行（给 agent 用；输出 JSON）

读：
  suixin info <文件>
  suixin outline <文件>
  suixin read <文件> [--section 标题] [--from 块id] [--limit N] [--markdown]
  suixin find <文件> <文字> [--regex] [--in 段落id/标题]
  suixin suggestions <文件> [--state pending|accepted|rejected|all] [--author 名字]
  suixin flavor <文件> [--section 标题 | --block 段落id] [--genre fiction|essay|general]
                                             AI 味检查：指数（相对基线的超标程度）、命中的套路与改法
  suixin flavor <文件> (--text 文字 | --text-file 路径)
                                             提建议前自检一段文字
                                             --baseline 名字：按作者的个人基线算（默认按文稿的选择 / 默认基线）
  suixin baseline [list]                     作者的 AI 味个人基线（与 App 共用）
  suixin baseline build <名字> <作者原文…> [--default]
                                             用作者自己写的 .txt / .md / 工程文件建立基线
  suixin baseline default <名字|内置>  ·  suixin baseline remove <名字>

改（默认只提建议，作者在 App 里确认）：
  suixin replace <文件> <定位> (--text 文字 | --text-file 路径) [--why 理由]
  suixin delete  <文件> <定位> [--why 理由]
  suixin insert  <文件> (--after start|end | --after-block id | --after-quote 原文 | --after-section 标题)
                        (--text 文字 | --text-file 路径) [--why 理由]
  suixin note    <文件> <定位> --issue 问题 --advice 建议
  suixin withdraw <文件> --suggestion id
  suixin apply   <文件> <ops.json | ->       批量操作，要么全成功要么全不生效
  suixin run     <文件> <操作名> [--参数 值 …] 任意操作（值可写 JSON）

定位：--quote 原文 [--occurrence N] [--in 段落id/标题] | --block id | --blocks id,id | --section 标题

图片（文稿里的图片是单独一段 ![图注](稿.assets/xxx.png)）：
  suixin images <文件>                       所有图片：图注、绝对路径、尺寸
  suixin image add <文件> <图片路径或网址> [--after …（同 insert，默认 end）] [--caption 图注] [--why 理由]
                                             存进文稿的资源文件夹并插入（默认成为待确认建议）
  suixin image show <文件> (--block 图片段落id | --src 路径) [-o 输出文件]
                                             给出图片文件的路径，多模态模型可以直接看

交给 Agent 的任务（作者在 App 里选中一处、写下要求交给你）：
  suixin tasks <文件> [--state active|open|claimed|done|all]
  suixin claim <文件> <任务id>                接手；之后照常提建议
  suixin done  <文件> <任务id> [--summary 说明]

与正在运行的 App 实时协作：
  suixin status                              App 是否在线、打开的文稿、作者的选区
  suixin selection                           作者当前选中的内容（附可直接使用的定位）
  suixin wait [--since 游标] [--timeout 秒] [--types a,b]
                                             等待作者的动作（接受 / 放弃建议、交办任务、选区变化…）
  suixin request-access [--why 理由]         请作者授权直接修改（App 里弹窗，最多等 3 分钟）

<文件> 写成 @ 表示 App 里正在打开的那篇。App 开着且打开的正是这个文件时，
操作交给 App 执行，建议立即出现在作者眼前；否则直接读写文件。

排版与导出（PDF / 截图借用本机的 Chrome 或 Edge）：
  suixin render <文件> [--section 标题] [--style reading|zhihu] [--width 820] [--page-height 1400]
                [--page 起始页] [--pages 最多几页] [-o 目录]
                                             按页截图（PNG），多模态模型可以直接看版面
  suixin export <文件> --format html|md|pdf|json [-o 输出文件] [--style reading|zhihu]
                                             html 为单文件（图片内嵌）；md 带 -o 时图片复制到旁边的 .assets/
  suixin export <文件> --format zhihu -o 目录  知乎发布包：在知乎写文章页执行 publish.js 即把内容与图片
                                             按顺序填进草稿（不会点发布），见包里的说明.md

其他：
  suixin new <文件> [--from a.md] [--title 标题] [--force]
  suixin ops                                 全部操作与参数（JSON Schema）
  suixin guide                               给 agent 的使用说明
  suixin mcp [--as 名字] [--file 文稿]       以 MCP 服务运行（stdio），供 harness 直接调用

通用选项：
  --as 名字     署名（默认取环境变量 SUIXIN_AGENT）
  --direct      直接修改（需作者在 App 里授权）
  --dry-run     只返回结果，不写文件
环境变量 SUIXIN_NO_BRIDGE=1 可强制只读写文件。
`

/* ── 参数解析 ─────────────────────────────────────── */

interface Parsed {
  positional: string[]
  flags: Record<string, string | true>
}

const BOOLEAN_FLAGS = new Set(['direct', 'dry-run', 'regex', 'markdown', 'force', 'help', 'h'])

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-') positional.push(a)
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
      if (eq > 0) flags[key] = a.slice(eq + 1)
      else if (BOOLEAN_FLAGS.has(key) || i + 1 >= argv.length) flags[key] = true
      else flags[key] = argv[++i]
    } else if (a === '-o') flags.o = argv[++i]
    else if (a === '-h') flags.help = true
    else positional.push(a)
  }
  return { positional, flags }
}

function str(flags: Parsed['flags'], key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

function usageError(message: string): AgentError {
  return new AgentError('INVALID_PARAMS', message, '运行 suixin --help 查看用法')
}

function targetFrom(flags: Parsed['flags']): TargetSpec {
  const t: TargetSpec = {}
  if (str(flags, 'quote') !== undefined) t.quote = str(flags, 'quote')
  if (str(flags, 'block') !== undefined) t.block = str(flags, 'block')
  if (str(flags, 'blocks') !== undefined) t.blocks = str(flags, 'blocks')!.split(',').map((x) => x.trim())
  if (str(flags, 'section') !== undefined) t.section = str(flags, 'section')
  if (str(flags, 'occurrence') !== undefined) t.occurrence = Number(str(flags, 'occurrence'))
  if (str(flags, 'in') !== undefined) t.in = str(flags, 'in')
  return t
}

/** 插入位置：--after start|end | --after-block | --after-quote | --after-section */
function afterFrom(flags: Parsed['flags']): 'start' | 'end' | TargetSpec | null {
  const at = str(flags, 'after')
  if (at === 'start' || at === 'end') return at
  if (str(flags, 'after-block')) return { block: str(flags, 'after-block') }
  if (str(flags, 'after-quote')) return { quote: str(flags, 'after-quote') }
  if (str(flags, 'after-section')) return { section: str(flags, 'after-section') }
  return null
}

async function textFrom(flags: Parsed['flags'], io: CliIO): Promise<string> {
  const text = str(flags, 'text')
  const file = str(flags, 'text-file')
  if (text !== undefined) return text
  if (file === '-') return io.readStdin()
  if (file) return fs.readFile(path.resolve(io.cwd, file), 'utf8')
  throw usageError('缺少 --text 或 --text-file')
}

function paramValue(raw: string | true): unknown {
  if (raw === true) return true
  const t = raw.trim()
  if (/^[[{"]/.test(t) || /^(true|false|null|-?\d+(\.\d+)?)$/.test(t)) {
    try {
      return JSON.parse(t)
    } catch {
      return raw
    }
  }
  return raw
}

/* ── 命令 ─────────────────────────────────────────── */

function authorOf(flags: Parsed['flags'], io: CliIO): string {
  return str(flags, 'as') ?? io.env.SUIXIN_AGENT ?? 'Agent'
}

/** file 为 null 表示 App 里正在打开的那篇 */
async function operate(file: string | null, calls: OpCall[], flags: Parsed['flags'], io: CliIO): Promise<unknown> {
  const author = authorOf(flags, io)
  return operateVia(file, calls, {
    author,
    direct: flags.direct === true,
    dryRun: flags['dry-run'] === true,
    bridge: await connectBridge(io.env, author),
  })
}

/** 只能经实时桥完成的命令 */
async function online(flags: Parsed['flags'], io: CliIO, method: BridgeMethod, params?: Record<string, unknown>) {
  const bridge = await requireBridge(io.env, authorOf(flags, io))
  return callOnline(bridge, method, params)
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  const [cmd, fileArg, ...rest] = positional
  const print = (v: unknown) => io.stdout(`${JSON.stringify(v, null, 2)}\n`)

  if (!cmd || flags.help) {
    io.stdout(USAGE)
    // 主动要帮助算成功；什么都没给才算用法错误
    return cmd || flags.help ? 0 : 2
  }
  try {
    await loadBaselines(io.env)
    if (cmd === 'baseline') {
      print(await baselineCommand(positional.slice(1), { default: !!flags.default }, io.env, io.cwd))
      return 0
    }
    if (cmd === 'guide') {
      io.stdout(AGENT_GUIDE)
      return 0
    }
    if (cmd === 'ops') {
      print({ ok: true, ops: describeOps() })
      return 0
    }
    // 实时协作：不需要文件参数
    if (cmd === 'status') {
      const bridge = await connectBridge(io.env, authorOf(flags, io))
      const status = bridge ? await bridge.call('app.status').catch((e) => (e instanceof BridgeOffline ? null : Promise.reject(e))) : null
      print(
        status
          ? { ok: true, online: true, ...(status as object) }
          : { ok: true, online: false, hint: '随心写作没有运行：直接用 .suixin.json 文件路径读写' }
      )
      return 0
    }
    if (cmd === 'selection') {
      print({ ok: true, ...((await online(flags, io, 'doc.selection')) as object) })
      return 0
    }
    if (cmd === 'wait') {
      const params: Record<string, unknown> = {}
      const since = str(flags, 'since') ?? fileArg
      if (since !== undefined) params.since = Number(since)
      if (str(flags, 'timeout')) params.timeout = Math.round(Number(str(flags, 'timeout')) * 1000)
      if (str(flags, 'types')) params.types = str(flags, 'types')!.split(',').map((t) => t.trim())
      print({ ok: true, ...((await online(flags, io, 'events.wait', params)) as object) })
      return 0
    }
    if (cmd === 'request-access') {
      const r = (await online(flags, io, 'access.request', { reason: str(flags, 'why') ?? '' })) as { granted: boolean }
      print({ ok: r.granted, ...r })
      return r.granted ? 0 : 1
    }
    if (cmd === 'image') {
      // suixin image add|show <文件> …
      const [sub, docArg, source] = [fileArg, rest[0], rest[1]]
      if (!docArg) throw usageError('用法：suixin image add <文件> <图片路径或网址> … / suixin image show <文件> --block id')
      const doc = docArg === CURRENT_DOC ? null : path.resolve(io.cwd, docArg)
      const author = authorOf(flags, io)
      const bridge = await connectBridge(io.env, author)
      if (sub === 'add') {
        if (!source) throw usageError('image add 需要图片路径或网址')
        const image = await loadImageSource(source, io.cwd)
        print(
          await addImage(doc, image, {
            author,
            direct: flags.direct === true,
            dryRun: flags['dry-run'] === true,
            bridge,
            after: afterFrom(flags) ?? 'end',
            caption: str(flags, 'caption'),
            why: str(flags, 'why'),
          })
        )
        return 0
      }
      if (sub === 'show') {
        const img = await readImage(doc, { block: str(flags, 'block'), src: str(flags, 'src') }, bridge)
        let out = img.path
        // 指定了输出位置，或图片不在本机文件里（浏览器模式 / 网址）：写一份出来
        if (str(flags, 'o') || !out) {
          out = path.resolve(io.cwd, str(flags, 'o') ?? `suixin-image-${Date.now()}.${img.mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'}`)
          await fs.writeFile(out, img.bytes)
        }
        print({ ok: true, src: img.src, caption: img.caption, path: out, mime: img.mime, bytes: img.bytes.length, ...(imageSize(img.bytes) ?? {}) })
        return 0
      }
      throw usageError(`没有命令 image ${sub ?? ''}`)
    }
    if (!fileArg) throw usageError(`${cmd} 需要一个文件参数（或用 @ 表示 App 里打开的那篇）`)
    const file = fileArg === CURRENT_DOC ? null : path.resolve(io.cwd, fileArg)
    if (cmd === 'images') {
      const r = (await operate(file, [{ op: 'read', limit: 500 }], flags, io)) as { results: [{ blocks: { type: string }[] }] }
      print({ ok: true, images: r.results[0].blocks.filter((b) => b.type === 'image') })
      return 0
    }

    switch (cmd) {
      case 'tasks': {
        const call: OpCall = { op: 'tasks' }
        if (str(flags, 'state')) call.state = str(flags, 'state')
        print(await operate(file, [call], flags, io))
        return 0
      }
      case 'claim':
      case 'done': {
        const task = rest[0] ?? str(flags, 'task')
        if (!task) throw usageError(`${cmd} 需要任务 id（来自 suixin tasks）`)
        const call: OpCall = cmd === 'claim' ? { op: 'claim_task', task } : { op: 'complete_task', task }
        if (cmd === 'done' && str(flags, 'summary')) call.summary = str(flags, 'summary')
        print(await operate(file, [call], flags, io))
        return 0
      }
    }
    // 渲染类导出与排版截图：文稿可以在 App 里（@），也可以是文件
    const format = str(flags, 'format') ?? 'md'
    const out = str(flags, 'o') ? path.resolve(io.cwd, str(flags, 'o')!) : null
    if ((cmd === 'export' && (format === 'html' || format === 'pdf' || format === 'zhihu' || (format === 'md' && out))) || cmd === 'render') {
      const style = parseStyle(str(flags, 'style'))
      const doc = await loadForRender(file, await connectBridge(io.env, authorOf(flags, io)), cmd === 'render' ? str(flags, 'section') : undefined)
      if (cmd === 'render') {
        const width = Number(str(flags, 'width') ?? 820)
        const dir = out ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'suixin-preview-')))
        const r = await renderPngPages(
          doc,
          dir,
          {
            style,
            width,
            pageHeight: Number(str(flags, 'page-height') ?? 1400),
            maxPages: Number(str(flags, 'pages') ?? 6),
            firstPage: Number(str(flags, 'page') ?? 1) - 1,
          },
          io.env
        )
        print({ ok: true, style, width, ...r })
        return 0
      }
      if (format === 'md') {
        print({ ok: true, ...(await exportMarkdownWithImages(doc, out!)) })
        return 0
      }
      if (format === 'zhihu') {
        if (!out) throw usageError('export --format zhihu 需要 -o 输出目录')
        print({ ok: true, ...(await exportZhihu(doc, out)) })
        return 0
      }
      if (format === 'pdf') {
        if (!out) throw usageError('export --format pdf 需要 -o 输出文件')
        print({ ok: true, ...(await exportPdf(doc, out, style, io.env)) })
        return 0
      }
      const html = await selfContainedHtml(doc, style)
      if (out) {
        await writeAtomic(out, html)
        print({ ok: true, file: out })
      } else io.stdout(html)
      return 0
    }
    if (!file) {
      if (cmd === 'export' && format === 'md' && !out) {
        const r = (await operate(null, [{ op: 'read', format: 'markdown' }], flags, io)) as { results: [{ markdown: string }] }
        io.stdout(r.results[0].markdown.endsWith('\n') ? r.results[0].markdown : `${r.results[0].markdown}\n`)
        return 0
      }
      if (cmd === 'new' || cmd === 'export') throw usageError(`${cmd} 需要真实的文件路径，不能用 @`)
    }

    switch (cmd) {
      case 'new': {
        if (!flags.force) {
          const exists = await fs
            .access(file!)
            .then(() => true)
            .catch(() => false)
          if (exists) throw new AgentError('CONFLICT', `${fileArg} 已存在`, '加 --force 覆盖')
        }
        const from = str(flags, 'from')
        const source = from ? await fs.readFile(path.resolve(io.cwd, from), 'utf8') : ''
        const title = str(flags, 'title') ?? (from ? path.basename(from).replace(/\.[^.]+$/, '') : '未命名文稿')
        const { project } = projectFromText(source, title)
        if (str(flags, 'title')) project.meta.title = title
        await writeAtomic(file!, serializeProject(project))
        print({ ok: true, file, title: project.meta.title, blocks: project.blocks.length })
        return 0
      }
      case 'export': {
        const { data } = await loadProject(file!)
        const format = str(flags, 'format') ?? 'md'
        const content = format === 'json' ? serializeProject(data) : exportMarkdown(data)
        const out = str(flags, 'o')
        if (out) {
          await writeAtomic(path.resolve(io.cwd, out), content)
          print({ ok: true, file: path.resolve(io.cwd, out) })
        } else io.stdout(content)
        return 0
      }
      case 'info':
      case 'outline':
        print(await operate(file, [{ op: cmd }], flags, io))
        return 0
      case 'read': {
        const params: OpCall = { op: 'read' }
        if (str(flags, 'section')) params.section = str(flags, 'section')
        if (str(flags, 'from')) params.from = str(flags, 'from')
        if (str(flags, 'limit')) params.limit = Number(str(flags, 'limit'))
        if (flags.markdown) params.format = 'markdown'
        const r = (await operate(file, [params], flags, io)) as { results: [{ markdown?: string }] }
        if (flags.markdown && r.results[0].markdown !== undefined) io.stdout(`${r.results[0].markdown}\n`)
        else print(r)
        return 0
      }
      case 'find': {
        const text = rest[0] ?? str(flags, 'text')
        if (!text) throw usageError('find 需要要找的文字')
        const call: OpCall = { op: 'find', text }
        if (flags.regex) call.regex = true
        if (str(flags, 'in')) call.in = str(flags, 'in')
        print(await operate(file, [call], flags, io))
        return 0
      }
      case 'flavor': {
        const call: OpCall = { op: 'flavor' }
        if (str(flags, 'section')) call.section = str(flags, 'section')
        if (str(flags, 'block')) call.blocks = [str(flags, 'block')]
        if (str(flags, 'blocks')) call.blocks = str(flags, 'blocks')!.split(',')
        if (str(flags, 'genre')) call.genre = str(flags, 'genre')
        if (str(flags, 'baseline')) call.baseline = str(flags, 'baseline')
        if (str(flags, 'limit')) call.limit = Number(str(flags, 'limit'))
        if (flags.text !== undefined || flags['text-file'] !== undefined) call.text = await textFrom(flags, io)
        print(await operate(file, [call], flags, io))
        return 0
      }
      case 'suggestions': {
        const call: OpCall = { op: 'suggestions' }
        if (str(flags, 'state')) call.state = str(flags, 'state')
        if (str(flags, 'author')) call.author = str(flags, 'author')
        print(await operate(file, [call], flags, io))
        return 0
      }
      case 'replace':
        print(
          await operate(
            file,
            [{ op: 'replace', target: targetFrom(flags), text: await textFrom(flags, io), ...(str(flags, 'why') ? { why: str(flags, 'why') } : {}) }],
            flags,
            io
          )
        )
        return 0
      case 'delete':
        print(await operate(file, [{ op: 'delete', target: targetFrom(flags), ...(str(flags, 'why') ? { why: str(flags, 'why') } : {}) }], flags, io))
        return 0
      case 'insert': {
        const after = afterFrom(flags)
        if (!after) throw usageError('insert 需要 --after start|end、--after-block、--after-quote 或 --after-section')
        print(
          await operate(
            file,
            [{ op: 'insert', after, text: await textFrom(flags, io), ...(str(flags, 'why') ? { why: str(flags, 'why') } : {}) }],
            flags,
            io
          )
        )
        return 0
      }
      case 'note': {
        const issue = str(flags, 'issue')
        const advice = str(flags, 'advice')
        if (!issue || !advice) throw usageError('note 需要 --issue 与 --advice')
        print(await operate(file, [{ op: 'note', target: targetFrom(flags), issue, advice }], flags, io))
        return 0
      }
      case 'withdraw':
        print(await operate(file, [{ op: 'withdraw', suggestion: str(flags, 'suggestion') ?? '' }], flags, io))
        return 0
      case 'apply': {
        const source = rest[0]
        if (!source) throw usageError('apply 需要 ops.json 或 -（从标准输入读取）')
        const raw = source === '-' ? await io.readStdin() : await fs.readFile(path.resolve(io.cwd, source), 'utf8')
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          throw new AgentError('INVALID_PARAMS', '操作列表不是有效的 JSON')
        }
        const calls = Array.isArray(parsed) ? parsed : (parsed as { ops?: unknown }).ops
        if (!Array.isArray(calls)) throw new AgentError('INVALID_PARAMS', '需要一个操作数组，或 {"ops": [...]}')
        print(await operate(file, calls as OpCall[], flags, io))
        return 0
      }
      case 'run': {
        const op = rest[0]
        if (!op) throw usageError('run 需要操作名，运行 suixin ops 查看')
        const skip = new Set(['as', 'direct', 'dry-run'])
        const call: OpCall = { op }
        for (const [k, v] of Object.entries(flags)) if (!skip.has(k)) call[k] = paramValue(v)
        print(await operate(file, [call], flags, io))
        return 0
      }
      default:
        throw usageError(`没有命令 ${cmd}`)
    }
  } catch (e) {
    const err = toAgentError(e)
    const index = (e as { index?: number }).index
    print({ ok: false, error: err.toJSON(), ...(index !== undefined ? { index } : {}) })
    return err.code === 'INVALID_PARAMS' || err.code === 'UNKNOWN_OP' ? 2 : 1
  }
}

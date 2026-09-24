/**
 * AI 味检查与打分（设计见 docs/AI味方案.md）。
 *
 * 打分沿用作者的 round_score：只有超出作者基线（没有就用内置人类基线）× 1.5 的密度才计罚分，
 * 罚分 = 超标 × 严重度权重 × 2；再换算成 0–100 的"AI 味指数"（越高越重）。
 * 数字只用来找嫌疑，由作者定案：每一处命中都带规则、原因与改法。
 */
import {
  RULES,
  SEVERITY_WEIGHT,
  STRUCTURE_FINDINGS,
  sentenceSpans,
  wordLength,
  type FlavorRule,
  type Genre,
  type Severity,
  type Span,
  type StructureFindingId,
} from './rules'

export interface FlavorBaseline {
  name: string
  /** 基线文字的总字数（不计标点空白） */
  chars: number
  /** 各规则的命中数 */
  counts: Record<string, number>
  builtFrom?: string[]
  createdAt?: string
}

export interface FlavorOptions {
  /** 文体；默认按对白占比自动判断 */
  genre?: Genre | 'auto'
  /** 作者个人基线；没有就用内置人类基线 */
  baseline?: FlavorBaseline | null
  /** 不查的规则 */
  ignoreRules?: string[]
  /** 作者说"这处没问题"的命中：`规则id:原文` */
  ignoreHits?: string[]
}

export interface FlavorHit {
  rule: string
  name: string
  severity: Severity
  start: number
  end: number
  text: string
  /** 所在段落（整篇检查时） */
  block?: string
}

export interface RuleStat {
  rule: string
  name: string
  severity: Severity
  count: number
  /** 每万字 */
  density: number
  /** 允许的密度（基线 × 1.5） */
  allowance: number
  penalty: number
}

export interface StructureFinding {
  id: StructureFindingId
  name: string
  severity: Severity
  detail: string
  penalty: number
  /** 涉及的句子（句模复用） */
  hits?: FlavorHit[]
}

export type FlavorLevel = '太短' | '清爽' | '轻微' | '明显' | '浓重'

export interface FlavorReport {
  /** 0–100，越高 AI 味越重；文字太短时为 null（只看命中） */
  index: number | null
  level: FlavorLevel
  genre: Genre
  /** 字数（不计标点空白） */
  chars: number
  hits: FlavorHit[]
  rules: RuleStat[]
  findings: StructureFinding[]
  /** 用的哪份基线 */
  baseline: string
}

export interface BlockInput {
  id: string
  type: 'heading' | 'paragraph'
  text: string
}

export interface BlockFlavor {
  block: string
  index: number | null
  level: FlavorLevel
  hits: FlavorHit[]
}

export interface DocumentFlavor extends FlavorReport {
  blocks: BlockFlavor[]
}

const TOLERANCE = 1.5
const PENALTY_PER_UNIT = 2
/** 单条规则的罚分上限：边际递减，免得一个口头禅压倒一切；轻 / 提醒级规则单独最多到"轻微" */
const RULE_CAP = 50
const SEVERITY_CAP: Record<Severity, number> = { high: RULE_CAP, medium: RULE_CAP, low: 20, reminder: 10 }
const INDEX_SCALE = 60
const SMOOTH_DOC = 1000
const SMOOTH_BLOCK = 600
const MIN_CHARS = 20

/* ── 基础 ─────────────────────────────────────────── */

/** 字数：不计标点与空白 */
export function countChars(text: string): number {
  return wordLength(text)
}

const QUOTES: [string, string][] = [
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
]

/** 对白（引号里的文字）的位置 */
export function dialogueSpans(text: string): Span[] {
  const out: Span[] = []
  for (const [open, close] of QUOTES) {
    let i = text.indexOf(open)
    while (i >= 0) {
      const j = text.indexOf(close, i + 1)
      // 没有配对的引号：到段末为止（中文小说里跨段的长对白常这样写）
      const end = j < 0 ? text.length : j + 1
      out.push([i, end])
      i = text.indexOf(open, end)
    }
  }
  // 英文直引号：成对出现才算
  const straight = [...text.matchAll(/"/g)].map((m) => m.index ?? 0)
  for (let k = 0; k + 1 < straight.length; k += 2) out.push([straight[k], straight[k + 1] + 1])
  return out.sort((a, b) => a[0] - b[0])
}

function inside(pos: number, spans: Span[]): boolean {
  return spans.some(([s, e]) => pos >= s && pos < e)
}

function narrationChars(text: string, dialogue: Span[]): number {
  let t = text
  for (const [s, e] of [...dialogue].sort((a, b) => b[0] - a[0])) t = t.slice(0, s) + t.slice(e)
  return countChars(t)
}

/** 按对白占比与第三人称密度猜文体 */
export function guessGenre(text: string): Genre {
  const total = countChars(text)
  if (!total) return 'general'
  const dialogue = dialogueSpans(text).reduce((n, [s, e]) => n + countChars(text.slice(s, e)), 0)
  if (dialogue / total >= 0.08) return 'fiction'
  const pronouns = (text.match(/[他她]/g) ?? []).length
  if (pronouns / total >= 0.012) return 'fiction'
  return 'essay'
}

export function effectiveSeverity(rule: FlavorRule, genre: Genre): Severity | null {
  const s = rule.genres?.[genre]
  if (s === 'off') return null
  return s ?? rule.severity
}

export function levelOf(index: number | null): FlavorLevel {
  if (index == null) return '太短'
  if (index < 15) return '清爽'
  if (index < 35) return '轻微'
  if (index < 60) return '明显'
  return '浓重'
}

function toIndex(penalty: number): number {
  return Math.round(100 * (1 - Math.exp(-penalty / INDEX_SCALE)))
}

/* ── 找命中 ───────────────────────────────────────── */

interface Scan {
  /** 每条规则的命中总数（计分用） */
  counts: Map<string, number>
  /** 列给作者看的命中 */
  hits: FlavorHit[]
  chars: number
  narration: number
}

function activeRules(genre: Genre, opts: FlavorOptions): { rule: FlavorRule; severity: Severity }[] {
  const ignore = new Set(opts.ignoreRules ?? [])
  return RULES.flatMap((rule) => {
    const severity = effectiveSeverity(rule, genre)
    return severity && !ignore.has(rule.id) ? [{ rule, severity }] : []
  })
}

function scan(text: string, genre: Genre, opts: FlavorOptions, block?: string): Scan {
  const dialogue = dialogueSpans(text)
  const ignoreHits = new Set(opts.ignoreHits ?? [])
  const counts = new Map<string, number>()
  const hits: FlavorHit[] = []
  for (const { rule, severity } of activeRules(genre, opts)) {
    let n = 0
    let listed = 0
    for (const [start, end] of rule.find(text)) {
      if (rule.scope === 'narration' && inside(start, dialogue)) continue
      const t = text.slice(start, end)
      if (ignoreHits.has(`${rule.id}:${t}`)) continue
      n++
      if (rule.perBlock === undefined || listed < rule.perBlock) {
        hits.push({ rule: rule.id, name: rule.name, severity, start, end, text: t, ...(block ? { block } : {}) })
        listed++
      }
    }
    if (n) counts.set(rule.id, n)
  }
  return { counts, hits, chars: countChars(text), narration: narrationChars(text, dialogue) }
}

/* ── 打分 ─────────────────────────────────────────── */

function baseDensity(rule: FlavorRule, baseline: FlavorBaseline | null | undefined): number {
  if (baseline && baseline.chars > 0) return ((baseline.counts[rule.id] ?? 0) / baseline.chars) * 10000
  return rule.base
}

function scoreRules(
  counts: Map<string, number>,
  chars: number,
  narration: number,
  smoothing: number,
  genre: Genre,
  opts: FlavorOptions
): RuleStat[] {
  const out: RuleStat[] = []
  for (const { rule, severity } of activeRules(genre, opts)) {
    const count = counts.get(rule.id) ?? 0
    if (!count) continue
    const n = rule.scope === 'narration' ? narration : chars
    if (rule.minChars && n < rule.minChars) continue
    // 轻 / 提醒级规则要有真正的密度证据：短文字里出现一两次不算
    const smooth = severity === 'low' || severity === 'reminder' ? Math.max(smoothing, 2000) : smoothing
    const density = (count / Math.max(n, smooth)) * 10000
    const allowance = baseDensity(rule, opts.baseline) * TOLERANCE
    const excess = Math.max(0, density - allowance)
    const penalty = Math.min(SEVERITY_CAP[severity], excess * SEVERITY_WEIGHT[severity] * PENALTY_PER_UNIT)
    out.push({
      rule: rule.id,
      name: rule.name,
      severity,
      count,
      density: round1(density),
      allowance: round1(allowance),
      penalty: round1(penalty),
    })
  }
  return out.sort((a, b) => b.penalty - a.penalty || b.count - a.count)
}

/** 轻 / 提醒级规则只在超标时才列出具体位置：句式没有罪，密了才有 */
function visibleHits(hits: FlavorHit[], stats: RuleStat[]): FlavorHit[] {
  const over = new Set(stats.filter((s) => s.penalty > 0).map((s) => s.rule))
  return hits.filter((h) => h.severity === 'high' || h.severity === 'medium' || over.has(h.rule))
}

const round1 = (x: number) => Math.round(x * 10) / 10

/* ── 对外：一段文字 ───────────────────────────────── */

/** 检查一段文字（一段正文、一段待提交的改写） */
export function analyzeText(text: string, opts: FlavorOptions = {}): FlavorReport {
  const genre = !opts.genre || opts.genre === 'auto' ? guessGenre(text) : opts.genre
  const s = scan(text, genre, opts)
  const rules = scoreRules(s.counts, s.chars, s.narration, SMOOTH_BLOCK, genre, opts)
  const penalty = rules.reduce((n, r) => n + r.penalty, 0)
  const index = s.chars < MIN_CHARS ? null : toIndex(penalty)
  return {
    index,
    level: levelOf(index),
    genre,
    chars: s.chars,
    hits: visibleHits(s.hits, rules),
    rules,
    findings: [],
    baseline: opts.baseline?.name ?? '内置',
  }
}

/* ── 对外：整篇 / 整节 ────────────────────────────── */

const SKIP_BLOCK = /^\s*(?:!\[[^\]]*\]\([^)]*\)\s*$|```|~~~)/

/** 检查整篇（或某一节的若干块）。标题、图片、代码块不查 */
export function analyzeDocument(blocks: BlockInput[], opts: FlavorOptions = {}): DocumentFlavor {
  const paras = blocks.filter((b) => b.type === 'paragraph' && b.text.trim() && !SKIP_BLOCK.test(b.text))
  const all = paras.map((b) => b.text).join('\n')
  const genre = !opts.genre || opts.genre === 'auto' ? guessGenre(all) : opts.genre

  const counts = new Map<string, number>()
  let chars = 0
  let narration = 0
  const perBlock: { id: string; scan: Scan }[] = []
  for (const b of paras) {
    const s = scan(b.text, genre, opts, b.id)
    perBlock.push({ id: b.id, scan: s })
    chars += s.chars
    narration += s.narration
    for (const [k, v] of s.counts) counts.set(k, (counts.get(k) ?? 0) + v)
  }

  const rules = scoreRules(counts, chars, narration, SMOOTH_DOC, genre, opts)
  const findings = structureFindings(paras, genre, chars, opts)
  const penalty = rules.reduce((n, r) => n + r.penalty, 0) + findings.reduce((n, f) => n + f.penalty, 0)
  const index = chars < MIN_CHARS ? null : toIndex(penalty)

  const docHits = visibleHits(
    perBlock.flatMap((b) => b.scan.hits),
    rules
  )
  const blockViews: BlockFlavor[] = perBlock.map(({ id, scan: s }) => {
    const bRules = scoreRules(s.counts, s.chars, s.narration, SMOOTH_BLOCK, genre, opts)
    const bPenalty = bRules.reduce((n, r) => n + r.penalty, 0)
    const bIndex = s.chars < MIN_CHARS ? null : toIndex(bPenalty)
    const shown = new Set(docHits.filter((h) => h.block === id))
    return { block: id, index: bIndex, level: levelOf(bIndex), hits: s.hits.filter((h) => shown.has(h)) }
  })
  // 句模复用的句子也标到段落上
  for (const f of findings) {
    for (const h of f.hits ?? []) blockViews.find((b) => b.block === h.block)?.hits.push(h)
  }
  for (const b of blockViews) b.hits.sort((x, y) => x.start - y.start)

  return {
    index,
    level: levelOf(index),
    genre,
    chars,
    hits: [...docHits, ...findings.flatMap((f) => f.hits ?? [])],
    rules,
    findings,
    baseline: opts.baseline?.name ?? '内置',
    blocks: blockViews,
  }
}

/* ── 结构：句模复用、句长 / 段长均匀 ─────────────── */

const OPENERS = ['看着', '望着', '盯着', '听着', '想着', '仿佛', '好像', '似乎', '那一刻', '这一刻', '一瞬间', '刹那间', '就在这时', '紧接着', '下一秒']
const SKELETONS: [string, RegExp][] = [
  // 只收有区分度的骨架；虽然…但、因为…所以这类普通关联词人写得一样多（实测作者原文"虽然…但"每万字 14 次）
  ['当…时', /^(?:每)?当[^。！？]{1,30}(?:时|的时候)/],
  ['看着…不禁', /看着[^。！？]{1,20}不禁/],
  ['就像…一样', /(?:就像|就好像|像是)[^。！？]{1,20}(?:一样|一般|似的)/],
]

function fingerprint(sentence: string): string | null {
  const s = sentence.replace(/^[“「『"'\s]+/, '')
  const skeleton = SKELETONS.find(([, re]) => re.test(s))?.[0]
  if (skeleton) return `骨架「${skeleton}」`
  const opener = OPENERS.find((o) => s.startsWith(o))
  if (!opener) return null
  const len = wordLength(s)
  return `以「${opener}」开头的${len <= 8 ? '短' : len <= 20 ? '中' : '长'}句`
}

function cv(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  if (!mean) return 0
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length)
  return sd / mean
}

function finding(id: StructureFindingId, detail: string, penalty: number, hits?: FlavorHit[]): StructureFinding {
  const f = STRUCTURE_FINDINGS[id]
  return { id, name: f.name, severity: f.severity, detail, penalty, ...(hits ? { hits } : {}) }
}

function structureFindings(paras: BlockInput[], genre: Genre, chars: number, opts: FlavorOptions): StructureFinding[] {
  const ignore = new Set(opts.ignoreRules ?? [])
  const out: StructureFinding[] = []
  const sentences: { block: string; start: number; end: number; text: string }[] = []
  for (const b of paras) {
    const dialogue = dialogueSpans(b.text)
    for (const [s, e] of sentenceSpans(b.text)) {
      if (inside(s, dialogue)) continue
      sentences.push({ block: b.id, start: s, end: e, text: b.text.slice(s, e) })
    }
  }

  // 句模复用：同一指纹出现 3 次以上，且每万字 5 次以上
  if (!ignore.has('template_reuse')) {
    const groups = new Map<string, typeof sentences>()
    for (const s of sentences) {
      const fp = fingerprint(s.text)
      if (fp) groups.set(fp, [...(groups.get(fp) ?? []), s])
    }
    const W = SEVERITY_WEIGHT[STRUCTURE_FINDINGS.template_reuse.severity] * PENALTY_PER_UNIT
    let total = 0
    for (const [fp, list] of groups) {
      if (list.length < 3 || (list.length / Math.max(chars, SMOOTH_DOC)) * 10000 < 5) continue
      const penalty = Math.min(RULE_CAP - total, W)
      total += penalty
      out.push(
        finding(
          'template_reuse',
          `${fp}出现 ${list.length} 次`,
          penalty,
          list.map((s) => ({
            rule: 'template_reuse',
            name: `句模复用：${fp}`,
            severity: STRUCTURE_FINDINGS.template_reuse.severity,
            start: s.start,
            end: s.end,
            text: s.text,
            block: s.block,
          }))
        )
      )
    }
  }

  const lowPenalty = SEVERITY_WEIGHT.low * PENALTY_PER_UNIT
  if (genre !== 'essay' && !ignore.has('sentence_uniformity')) {
    const lens = sentences.map((s) => wordLength(s.text)).filter((n) => n >= 5)
    if (lens.length >= 10) {
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length
      const c = cv(lens)
      if (mean >= 5 && c < 0.4) {
        out.push(finding('sentence_uniformity', `${lens.length} 句的句长变异系数 ${c.toFixed(2)}（< 0.4）`, lowPenalty))
      }
    }
  }
  if (!ignore.has('paragraph_uniformity')) {
    const lens = paras.map((b) => countChars(b.text))
    if (lens.length >= 8) {
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length
      const c = cv(lens)
      if (mean >= 10 && c < 0.5) {
        out.push(finding('paragraph_uniformity', `${lens.length} 段的段长变异系数 ${c.toFixed(2)}（< 0.5）`, lowPenalty))
      }
    }
  }
  return out
}

/* ── 改写前后对比（agent 提交修改、内置 AI 生成后自检） ── */

export interface FlavorDelta {
  before: number | null
  after: number | null
  /** 改写带进来的新套路：这条规则的命中比原文多 */
  added: FlavorHit[]
  /** 原文有、改写后仍在（可能换了个说法）的套路 */
  kept: FlavorHit[]
  /** 消掉的套路 */
  removed: FlavorHit[]
}

/**
 * 改写前后对比，按规则计数：同一条规则在改写后少了算消掉，多了算新增，
 * 没少（比如"不是为了看天，而是"换成了"不是在看天，是"）算仍在。只看重 / 中级别。
 */
export function flavorDelta(before: string, after: string, opts: FlavorOptions = {}): FlavorDelta {
  const genre = !opts.genre || opts.genre === 'auto' ? guessGenre(before || after) : opts.genre
  const a = analyzeText(before, { ...opts, genre })
  const b = analyzeText(after, { ...opts, genre })
  const serious = (h: FlavorHit) => h.severity === 'high' || h.severity === 'medium'
  const hitsA = scan(before, genre, opts).hits.filter(serious)
  const hitsB = scan(after, genre, opts).hits.filter(serious)
  const byRule = (hs: FlavorHit[]) => {
    const m = new Map<string, FlavorHit[]>()
    for (const h of hs) m.set(h.rule, [...(m.get(h.rule) ?? []), h])
    return m
  }
  const ra = byRule(hitsA)
  const rb = byRule(hitsB)
  const added: FlavorHit[] = []
  const kept: FlavorHit[] = []
  const removed: FlavorHit[] = []
  for (const rule of new Set([...ra.keys(), ...rb.keys()])) {
    const xa = ra.get(rule) ?? []
    const xb = rb.get(rule) ?? []
    const oldTexts = new Set(xa.map((h) => h.text))
    const newTexts = new Set(xb.map((h) => h.text))
    if (xb.length > xa.length) {
      // 多出来的：优先报原文里没有的那几处
      const fresh = xb.filter((h) => !oldTexts.has(h.text))
      added.push(...(fresh.length ? fresh : xb).slice(0, xb.length - xa.length))
      kept.push(...xb.filter((h) => !added.includes(h)).slice(0, xa.length))
    } else {
      kept.push(...xb)
      const gone = xa.filter((h) => !newTexts.has(h.text))
      removed.push(...(gone.length ? gone : xa).slice(0, xa.length - xb.length))
    }
  }
  return { before: a.index, after: b.index, added, kept, removed }
}

/** 由命中数建立个人基线（传入作者自己写的若干段文字） */
export function buildBaseline(name: string, texts: string[], builtFrom?: string[]): FlavorBaseline {
  const counts: Record<string, number> = {}
  let chars = 0
  // 基线要数全部命中：不按文体关掉规则，也不受每段只列一处的限制
  for (const text of texts) {
    const dialogue = dialogueSpans(text)
    chars += countChars(text)
    for (const rule of RULES) {
      const n = rule
        .find(text)
        .filter(([s]) => rule.scope !== 'narration' || !inside(s, dialogue)).length
      if (n) counts[rule.id] = (counts[rule.id] ?? 0) + n
    }
  }
  return { name, chars, counts, builtFrom, createdAt: new Date().toISOString() }
}

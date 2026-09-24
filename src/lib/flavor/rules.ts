/**
 * AI 味规则库（设计见 docs/AI味方案.md）。
 *
 * 每条规则都要说得清：是什么、为什么算 AI 味、往哪改、证据从哪来。
 * base 是内置的人类基线（每万字出现次数）：没有作者个人基线时，超过 base × 1.5 的部分才计分。
 * 规则只找"嫌疑"，由作者定案；宁可少收，不收区分度没有验证过的特征。
 */

export type Severity = 'high' | 'medium' | 'low' | 'reminder'
export type Genre = 'fiction' | 'essay' | 'general'
export type RuleCategory = '句式' | '套话' | '词汇' | '叙述' | '标点' | '结构'

export const SEVERITY_WEIGHT: Record<Severity, number> = { high: 10, medium: 4, low: 2, reminder: 1 }
export const SEVERITY_LABEL: Record<Severity, string> = { high: '重', medium: '中', low: '轻', reminder: '提醒' }

export type Span = [start: number, end: number]

export interface FlavorRule {
  id: string
  name: string
  category: RuleCategory
  severity: Severity
  /** 按文体调整严重度；'off' 表示这种文体不查 */
  genres?: Partial<Record<Genre, Severity | 'off'>>
  /** narration：跳过引号里的对白 */
  scope: 'all' | 'narration'
  /** 在一段文字里找命中，返回 [起, 止) */
  find: (text: string) => Span[]
  /** 内置人类基线：每万字 */
  base: number
  /** 同一段最多记几处（高频虚词每段只标一次，免得满屏） */
  perBlock?: number
  /** 文字少于这么多字不查（统计性规则） */
  minChars?: number
  why: string
  advice: string
  source: string
}

/* ── 构造匹配器 ─────────────────────────────────────── */

function re(pattern: RegExp): (text: string) => Span[] {
  const g = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
  return (text) => {
    const out: Span[] = []
    g.lastIndex = 0
    for (const m of text.matchAll(g)) {
      if (!m[0]) continue
      const s = m.index ?? 0
      out.push([s, s + m[0].length])
    }
    return out
  }
}

function words(list: string[]): (text: string) => Span[] {
  // 长词优先，免得"值得注意的是"被拆成更短的词
  const sorted = [...new Set(list)].sort((a, b) => b.length - a.length)
  return re(new RegExp(sorted.map(escapeRe).join('|'), 'g'))
}

function any(...fs: ((text: string) => Span[])[]): (text: string) => Span[] {
  return (text) => {
    const all = fs.flatMap((f) => f(text)).sort((a, b) => a[0] - b[0] || b[1] - a[1])
    // 去掉被包含的重复命中
    const out: Span[] = []
    for (const s of all) {
      const last = out[out.length - 1]
      if (last && s[0] < last[1]) continue
      out.push(s)
    }
    return out
  }
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 句子切分：按句末标点与换行，返回每句的 [起, 止) */
export function sentenceSpans(text: string): Span[] {
  const out: Span[] = []
  const g = /[^。！？!?…\n]+[。！？!?…]*[”」』"']?/g
  for (const m of text.matchAll(g)) {
    const s = m.index ?? 0
    const body = m[0]
    const lead = body.length - body.trimStart().length
    const trimmed = body.trim()
    if (trimmed) out.push([s + lead, s + lead + trimmed.length])
  }
  return out
}

/** 句子的实际字数（去掉标点与空白） */
export function wordLength(s: string): number {
  return s.replace(/[\s\p{P}\p{S}]/gu, '').length
}

/** 连续三个以上短句（≤8 字）以同一个字开头：机械排比 */
function shortParallel(text: string): Span[] {
  const spans = sentenceSpans(text)
  const out: Span[] = []
  let run: Span[] = []
  const flush = () => {
    if (run.length >= 3) out.push([run[0][0], run[run.length - 1][1]])
    run = []
  }
  for (const sp of spans) {
    const s = text.slice(sp[0], sp[1]).replace(/^[“「『"'\s]+/, '')
    const first = s[0]
    const short = wordLength(s) <= 8 && wordLength(s) >= 2
    const prev = run.length ? text.slice(run[0][0], run[0][1]).replace(/^[“「『"'\s]+/, '')[0] : null
    if (short && (run.length === 0 || first === prev)) run.push(sp)
    else {
      flush()
      if (short) run.push(sp)
    }
  }
  flush()
  return out
}

/** 顿号列举：一个分句里三项以上。列的是专名（格式、产品、服务名，多含字母数字）时是正常内容，不算 */
function denseEnumeration(text: string): Span[] {
  return re(/[^，。！？；：、,.;:!?\n]{1,12}(?:、[^，。！？；：、,.;:!?\n]{1,12}){2,}/g)(text).filter(([s, e]) => {
    const items = text.slice(s, e).split('、')
    return items.length >= 3 && items.filter((x) => /[A-Za-z0-9]/.test(x)).length * 2 < items.length
  })
}

/* ── 规则 ─────────────────────────────────────────── */

const NEG_LEAD = '(?<![是要若倘可])(?:并不是|并非|绝不是|从来不是|从来都不是|不是)(?!很|太|特别|吗|呢|么|嘛|吧|啊|不|没)'

export const RULES: FlavorRule[] = [
  /* 句式 */
  {
    id: 'neg_correction',
    name: '不是…而是…',
    category: '句式',
    severity: 'high',
    scope: 'narration',
    find: any(
      re(new RegExp(`${NEG_LEAD}[^。！？!?\\n]{1,24}?(?:[，,；;：:]\\s*|——\\s*|。\\s*)(?:而|只|更|恰恰|其实|反而|就)?是`, 'g')),
      re(new RegExp(`${NEG_LEAD}[^，。！？!?\\n；;]{1,24}?而是`, 'g'))
    ),
    base: 2.5,
    why: '先否定一个没人提过的说法再"纠正"，是模型最顽固的句式指纹；偶尔一用是修辞，密了就是 AI 味',
    advice: '直接说肯定的那一半；需要对比时换成具体的动作或细节（"不是握，是抓"这类具体对照可以保留）',
    source: 'lieflat 3.4×；AI查找 parallel_negation；瑶光病灶库 S-001（每章 1–2 处）',
  },
  {
    id: 'rather_than',
    name: '…，而不是…',
    category: '句式',
    severity: 'medium',
    scope: 'narration',
    find: re(/[^，。！？!?\n]{2,20}[，,]\s*而(?:不是|非)[^，。！？!?\n]{1,20}/g),
    base: 1.5,
    why: '"不是…而是…"的倒装变体，同样是先立靶子再纠正',
    advice: '去掉被否定的那一半，只说真正要说的',
    source: 'lieflat 否定对照族；作者实践',
  },
  {
    id: 'triple_negation',
    name: '不是A，也不是B，而是C',
    category: '句式',
    severity: 'high',
    scope: 'narration',
    find: re(/不是[^，。！？\n]{1,14}[，,]\s*也不是[^，。！？\n]{1,14}[，,；;]?\s*(?:而|只|就)?是/g),
    base: 0.2,
    why: '三连否定再揭晓，比二连更刻意',
    advice: '直接写 C；A、B 若真有信息量，拆成单独的叙述',
    source: 'character-sim revise.mjs 第 1 条；oh-story',
  },
  {
    id: 'negation_parade',
    name: '没有…，没有…',
    category: '句式',
    severity: 'medium',
    scope: 'narration',
    find: re(/(?:没有|不再)[^，。！？\n]{1,8}[，,]\s*(?:没有|不再)[^，。！？\n]{1,8}[，,]?\s*(?:也)?(?:没有|不再)?/g),
    base: 0.8,
    why: '否定排比用来"营造张力"，模型写得格外多',
    advice: '留一个最有分量的否定，或改成正面描写人物实际做了什么',
    source: 'oh-story story-deslop',
  },
  {
    id: 'sublimation',
    name: '不仅是…更是…',
    category: '句式',
    severity: 'high',
    scope: 'all',
    find: re(/(?:不仅仅是|不仅是|不只是|不单是|不但是|与其说是?)[^，。！？\n]{1,30}[，,]?\s*(?:更是|不如说是?|毋宁说是?)/g),
    base: 0.3,
    why: '递进拔高：把一件具体的事硬抬到更高的意义上',
    advice: '留下具体的那一层，删掉拔高的那一层',
    source: 'AI查找 abstract_sublimation；Wikipedia「not just X but Y」',
  },
  {
    id: 'uplift_ending',
    name: '升华收尾',
    category: '句式',
    severity: 'medium',
    scope: 'narration',
    find: any(
      re(/(?:这|那)[，,]?\s*(?:或许|也许|大概)?[，,]?\s*(?:就是|才是|正是|便是)[^。！？\n]{0,20}(?:意义|答案|力量|魅力|真谛|本质|所在|模样|样子|全部)/g),
      re(/(?:或许|也许)[，,]\s*这(?:就是|才是|正是)/g),
      re(/(?:也许|或许)[^。！？\n]{0,30}[。！？]\s*(?:也许|或许)[^。！？\n]{0,30}[。！？]\s*(?:也许|或许)/g)
    ),
    base: 0.3,
    why: '段末或章末用一句"这就是…的意义"把情绪总结出来，替读者下结论',
    advice: '停在具体的画面或动作上，让读者自己得出结论',
    source: '瑶光病灶库 S-002 / C-001；character-sim 第 9 条',
  },
  {
    id: 'short_parallel',
    name: '同字开头的短句排比',
    category: '句式',
    severity: 'medium',
    scope: 'all',
    find: shortParallel,
    base: 0.5,
    why: '三个以上短句同一个字开头，节奏是算出来的',
    advice: '保留铺垫的意思，打破同字开头与等长句子',
    source: 'AI查找 parallel_structure',
  },
  {
    id: 'symmetry',
    name: '既…又… / 一方面…另一方面',
    category: '句式',
    severity: 'low',
    scope: 'all',
    find: re(/既[^。！？\n，,]{1,15}又[^。！？\n]{1,15}|一方面[^。！？\n]{1,20}另一方面/g),
    base: 3,
    why: '对称结构本身正常，过密是模型"面面俱到"的习惯',
    advice: '只说更重要的那一面',
    source: 'AI查找 symmetry_obsession',
  },
  {
    id: 'still_turn',
    name: '依然…依然…但',
    category: '句式',
    severity: 'medium',
    scope: 'narration',
    find: re(/(?:依然|依旧)[^。！？\n]{0,25}(?:依然|依旧)[^。！？\n]{0,20}(?:但|却|可)/g),
    base: 0.2,
    why: '"一切如旧，唯独…"的模板句',
    advice: '直接写变化的那一样',
    source: 'AI查找 double_still_turn；瑶光病灶库 S-003',
  },
  {
    id: 'realization',
    name: '原来…也…一样',
    category: '句式',
    severity: 'reminder',
    scope: 'narration',
    find: re(/原来[^\n。！？]{0,20}也[^\n。！？]{0,6}(?:一样|同样|体会过|懂|有过|如此)/g),
    base: 0.3,
    why: '"原来他也一样"式的共情顿悟，是模型常用的情感落点',
    advice: '用人物的反应或行动表现理解，而不是说出来',
    source: 'AI查找 realization_empathy',
  },

  /* 套话 */
  {
    id: 'paper_transition',
    name: '论文腔过渡',
    category: '套话',
    severity: 'medium',
    genres: { fiction: 'high' },
    scope: 'narration',
    find: words([
      '综上所述', '与此同时', '值得注意的是', '值得一提的是', '需要指出的是', '需要注意的是', '换句话说', '由此可见',
      '毋庸置疑', '不言而喻', '众所周知', '不可否认', '不难发现', '显而易见', '进一步说', '换言之', '总而言之', '总的来说',
      '简而言之', '归根结底',
    ]),
    base: 1,
    why: '没有所指的判断性开头（"值得注意的是，"），是 AI 腔里区分度最高的特征之一',
    advice: '删掉过渡词，直接说那件值得注意的事；小说里更不该出现',
    source: 'AI查找 paper_transition；lieflat 4.4×',
  },
  {
    id: 'announce_colon',
    name: '宣布式冒号',
    category: '套话',
    severity: 'medium',
    genres: { fiction: 'low' },
    scope: 'narration',
    find: re(/(?:以下几点|如下几点|以下几个方面|主要有以下|原因很简单|答案很简单|道理很简单|答案是|核心是|关键是|本质是|一句话总结|一句话概括|简单来说|说白了|划重点|重点来了)[：:]/g),
    base: 0.8,
    why: '先宣布"要说重点了"再说，是提示词写法漏进了正文',
    advice: '去掉宣布，直接说内容',
    source: 'lieflat 3.8–9.4×',
  },
  {
    id: 'filler_opener',
    name: '口头垫话',
    category: '套话',
    severity: 'low',
    scope: 'narration',
    find: re(/(?<=(?:^|[。！？\n])\s*)(?:说白了|说到底|本质上|某种程度上|从某种意义上说|某种意义上)[，,]/g),
    base: 3,
    why: '句首垫一个"说白了，""本质上，"，内容却没变',
    advice: '删掉垫话',
    source: 'lieflat 3.2×',
  },
  {
    id: 'grand_opening',
    name: '宏大开头',
    category: '套话',
    severity: 'medium',
    scope: 'narration',
    find: re(/随着[^，。！？\n]{1,20}的(?:不断|快速|飞速|迅猛|日益|蓬勃)?发展|在[^，。！？\n]{1,16}的(?:新时代|时代|浪潮|大背景|背景下)|在当今(?:社会|时代|世界)/g),
    base: 0.5,
    why: '从时代大背景起笔，和要说的事关系不大',
    advice: '从具体的事、人或数字开头',
    source: 'Humanizer-zh；humanizer-chinese',
  },
  {
    id: 'canned_ending',
    name: '程式结尾与聊天残留',
    category: '套话',
    severity: 'high',
    scope: 'narration',
    find: words([
      '让我们拭目以待', '未来可期', '希望对你有帮助', '希望对您有帮助', '希望对你有所帮助', '希望对您有所帮助',
      '如果你还有其他问题', '如果您还有其他问题', '欢迎在评论区', '欢迎留言讨论', '作为一个AI', '作为一个人工智能',
      '作为AI助手', '好问题！', '让我们一起来看看', '一起来看看吧',
    ]),
    base: 0.1,
    why: '聊天助手的客套或模板化收尾，人写的正文里几乎不会出现',
    advice: '删掉；结尾停在最后一个有信息量的句子上',
    source: 'Wikipedia「Signs of AI writing」；blader/humanizer',
  },

  /* 词汇 */
  {
    id: 'jargon',
    name: '互联网黑话',
    category: '词汇',
    severity: 'medium',
    genres: { fiction: 'low' },
    scope: 'narration',
    find: words([
      '赋能', '抓手', '闭环', '底层逻辑', '破局', '颗粒度', '拉通', '深度融合', '无缝衔接', '组合拳', '顶层设计',
      '降本增效', '全方位', '多维度', '一站式', '全链路', '生态位', '方法论', '护城河',
    ]),
    base: 1,
    why: '空泛的行业黑话，信息量低',
    advice: '换成具体做了什么、改变了什么',
    source: 'ren644/de-ai-flavor-skill；humanizer-chinese',
  },
  {
    id: 'inflation',
    name: '拔高用语',
    category: '词汇',
    severity: 'medium',
    scope: 'narration',
    find: words([
      '彰显', '注入新的活力', '注入活力', '开启新篇章', '翻开新篇章', '谱写', '新篇章', '标志着', '里程碑式',
      '至关重要', '不可或缺', '举足轻重', '深远影响', '深远的影响', '重要意义', '扮演着重要的角色', '扮演着关键角色',
      '扮演着重要角色', '发挥着重要作用', '起着至关重要', '与时俱进', '熠熠生辉', '璀璨', '瑰宝',
    ]),
    base: 1.5,
    why: '夸大意义、堆砌分量词，是模型"显得重要"的方式',
    advice: '说清楚具体影响了什么，删掉形容分量的词',
    source: 'Wikipedia「inflated significance」；Humanizer-zh',
  },
  {
    id: 'soft_words',
    name: '高频虚词',
    category: '词汇',
    severity: 'reminder',
    scope: 'all',
    find: words(['仿佛', '宛如', '不禁', '微微', '蓦然', '淡淡', '浅浅', '轻轻', '缓缓', '静静', '默默', '悄然', '顿时', '霎时']),
    base: 5.3,
    perBlock: 1,
    why: '这些是正常中文，模型用得格外密；过密时整体读感发虚',
    advice: '只记录不强改。确实多余的地方换成具体动作，别换成另一个虚词（删掉常常会伤画面）',
    source: 'AI查找 ai_buzzwords（每万字 8 次以上才提醒）；瑶光病灶库 W-001',
  },

  /* 叙述 */
  {
    id: 'emotion_label',
    name: '情绪标注',
    category: '叙述',
    severity: 'low',
    genres: { essay: 'off' },
    scope: 'narration',
    find: re(/感到[一阵几股丝]?[^，。！？\n]{1,15}|涌上(?:心头|眉间|心间)|心头[一]?[紧颤动酸热]|内心(?:深处)?[^，。！？\n]{0,10}(?:涌|升|泛)起/g),
    // 人写的小说里也常见（作者原文每万字约 7 次），密度明显更高才提醒
    base: 6,
    why: '直接把情绪名字说出来，而不是让读者从动作和细节里感到',
    advice: '换成能引出这种情绪的动作、生理反应或细节',
    source: 'AI查找 emotion_labeling',
  },
  {
    id: 'abstract_feeling',
    name: '抽象感受名词',
    category: '叙述',
    severity: 'medium',
    genres: { essay: 'low' },
    scope: 'narration',
    find: words([
      '不真实感', '疏离感', '违和感', '孤独感', '失落感', '空虚感', '无力感', '窒息感', '荒诞感', '陌生感', '抽离感',
      '恍惚感', '局促感', '窘迫感', '荒谬感', '虚无感', '焦灼感', '怅然感', '寂寥感', '孤寂感', '苍凉感', '挫败感',
      '悬空感', '撕裂感',
    ]),
    base: 0.8,
    why: '"一种疏离感"是给感受贴标签',
    advice: '写出造成这种感受的具体情形',
    source: 'AI查找 abstract_feeling_noun',
  },
  {
    id: 'empty_lyrical',
    name: '空泛抒情',
    category: '叙述',
    severity: 'medium',
    genres: { essay: 'low' },
    scope: 'narration',
    find: any(
      words(['在这一刻', '空气中弥漫着', '刹那间', '时光仿佛', '岁月静好', '一切都静止了', '世界仿佛只剩下']),
      re(/时间[^。！？\n，,]{0,6}(?:静止|凝固|停滞|变慢|放慢|停止)|世界[^。！？\n]{0,8}只剩下?/g)
    ),
    base: 1,
    why: '时间静止、世界只剩下你我——现成的抒情模板',
    advice: '换成此时此地独有的细节',
    source: 'AI查找 empty_lyrical；瑶光「时间凝固」「世界只剩她」',
  },
  {
    id: 'role_metaphor',
    name: '拟人化的角色比喻',
    category: '叙述',
    severity: 'medium',
    scope: 'narration',
    find: re(/(?:像|宛如|如同|仿佛)(?:是)?(?:一位|一个|一名)[^，。！？\n]{0,10}(?:导师|母亲|父亲|老人|守护者|舞者|诗人|画家|哲人|战士|智者|老朋友|恋人|情人|孩子|使者)/g),
    base: 0.3,
    why: '"月光像一位温柔的母亲"：把物拟成一个角色，是 AI 比喻里区分度最高的一类',
    advice: '比喻要落在具体的形状、动作或触感上；拿不准就不用比喻',
    source: 'lieflat 7.3×',
  },
  {
    id: 'eye_light',
    name: '眼睛亮了 / 闪过',
    category: '叙述',
    severity: 'low',
    genres: { essay: 'off' },
    scope: 'narration',
    find: re(/(?:眼睛|眼神|目光|眼底|眼中|眼里)[^。！？\n，,]{0,10}(?:亮了|亮起来|发亮|发光|闪过|闪出|闪起|闪着)|闪闪发(?:亮|光)|闪着光/g),
    base: 0.8,
    why: '眼睛像开关一样亮起、黯淡，是网文与模型共用的套路',
    advice: '换成人物具体做了什么',
    source: 'AI查找 eye_lightup；瑶光评审 A-4',
  },
  {
    id: 'stock_image',
    name: '现成意象与感官套语',
    category: '叙述',
    severity: 'reminder',
    genres: { essay: 'off' },
    scope: 'narration',
    find: any(
      words([
        '淡淡的花香', '微风拂过', '阳光洒在', '阳光透过', '若有若无的香气', '鼻尖萦绕', '耳畔回响', '指尖传来',
        '褪去了白日的喧嚣', '褪去了喧嚣', '显得格外宁静', '显得异常宁静', '嘴角勾起', '嘴角上扬', '心中一凛',
        '空气仿佛凝固', '一抹弧度',
      ]),
      re(/(?:像|如|仿佛|宛如)[^\n。！？]{0,6}(?:一朵|几朵)?(?:绽开|绽放|盛开|初绽)的?花朵?|眼中闪过一丝/g)
    ),
    base: 1,
    why: '单独一个不说明问题（实测单词区分度很低），扎堆出现才是模板化写作',
    advice: '留一个最贴切的，其余换成这个场景独有的细节',
    source: 'AI查找 sensory_cliche / smile_flower / atmosphere_template；mochi-ruler 的反面结论',
  },
  {
    id: 'timing',
    name: '读秒',
    category: '叙述',
    severity: 'low',
    genres: { essay: 'off' },
    scope: 'narration',
    find: re(/(?:半|一|两|几|三)秒(?:钟)?(?:后|之后|的沉默|里|过去)|(?:过|隔)了(?:好)?一会儿?|停顿了(?:一|半)?(?:秒|拍)/g),
    base: 2,
    why: '精确到秒的停顿是模型营造节奏的惯用手法',
    advice: '删掉计时，用动作本身体现停顿',
    source: 'character-sim revise.mjs 第 2 条',
  },

  /* 标点 */
  {
    id: 'em_dash',
    name: '破折号',
    category: '标点',
    severity: 'medium',
    scope: 'narration', // 对白里的破折号多是打断、拖音，是人物口吻
    find: re(/——|—{2,}/g),
    base: 8,
    why: '人类中文每千字约 0.8 个，AI 高出 3 倍（DeepSeek、Claude 尤甚）；常用来"解释"或"揭晓"',
    advice: '改成逗号、句号或冒号；用破折号解释的内容，多半可以直接删',
    source: 'lieflat 3.0×（人类 0.80 / AI 2.38 每千字）；character-sim 第 5 条',
  },
  {
    id: 'dense_enum',
    name: '顿号列举',
    category: '标点',
    severity: 'low',
    scope: 'narration',
    find: denseEnumeration,
    base: 10,
    why: '一句里并列三项以上，面面俱到却没有重点',
    advice: '挑最重要的一两项展开',
    source: 'lieflat 1.8×',
  },

  /* 结构（整篇 / 整节才算，见 analyze.ts） */
  {
    id: 'transition_density',
    name: '转折词过密',
    category: '结构',
    severity: 'low',
    scope: 'narration',
    find: words(['然而', '但是', '不过', '可是', '却', '倒是']),
    base: 45,
    minChars: 2000,
    perBlock: 0,
    why: '转折一个接一个，是"制造起伏"的机械手法',
    advice: '删掉不必要的转折词，让事件自己转折',
    source: 'AI查找 transition_density（每千字 5 次以上）',
  },

  /* 英文 */
  {
    id: 'en_slop',
    name: '英文 AI 腔',
    category: '套话',
    severity: 'medium',
    scope: 'narration',
    find: re(/\b(?:delve(?:s|d)? into|a rich tapestry|tapestry of|testament to|it'?s not (?:just|only|merely) (?:about )?|in today'?s (?:fast-paced|digital|ever-changing) world|navigate the complexities|ever-evolving|let'?s dive in|here'?s what you need to know)\b/gi),
    base: 0.3,
    why: '英文里最常见的模型用语',
    advice: '换成普通说法，或直接删掉',
    source: 'Wikipedia「Signs of AI writing」；slop-score',
  },
]

/** 规则说明（给 agent 与界面用，不含匹配器） */
export function ruleInfo(rule: FlavorRule) {
  return {
    id: rule.id,
    name: rule.name,
    category: rule.category,
    severity: rule.severity,
    why: rule.why,
    advice: rule.advice,
    source: rule.source,
  }
}

/** 整篇 / 整节层面的统计性发现（没有具体位置） */
export const STRUCTURE_FINDINGS = {
  template_reuse: {
    name: '句模复用',
    severity: 'medium' as Severity,
    why: '同一个句子模板在全文反复出现——升华不是病，同款句模连按才是病',
    advice: '保留最好的一处，其余换成不同的写法',
    source: 'AI查找 structure_analyzer；瑶光评审（拥抱三件套、同一面湖）',
  },
  sentence_uniformity: {
    name: '句长过于均匀',
    severity: 'low' as Severity,
    why: '句子长短差不多（变异系数 < 0.4），节奏平；与文体有关，只作参考',
    advice: '让长短句交错，重要的地方用短句',
    source: 'AI查找 sentence_uniformity',
  },
  paragraph_uniformity: {
    name: '段落长度过于均匀',
    severity: 'low' as Severity,
    why: '每段差不多长，像按模板切出来的',
    advice: '该长的段落写足，该短的一句成段',
    source: 'AI查找 paragraph_uniformity',
  },
}
export type StructureFindingId = keyof typeof STRUCTURE_FINDINGS

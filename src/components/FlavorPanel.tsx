/**
 * AI 味面板：整篇的指数、选中段落的命中与改法、按规则汇总、最该先改的段落。
 * 打开时正文里标出命中。数字只用来找嫌疑，由作者定案（见 docs/AI味方案.md）。
 */
import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { BUILTIN, clearFlavorIgnores, flavorReport, ignoreFlavorHit, setFlavorBaseline, setFlavorGenre } from '../store/flavorActions'
import { useBaselineStore } from '../store/baselineStore'
import { BaselineModal } from './BaselineModal'
import { deflavorBlock } from '../store/aiActions'
import { RULES, SEVERITY_LABEL, type FlavorHit, type Genre } from '../lib/flavor'
import { getBlock } from '../lib/doc'
import { SegmentedControl } from './SegmentedControl'
import { IconX } from './icons'

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]))
const GENRE_LABEL: Record<Genre, string> = { fiction: '小说', essay: '文章', general: '通用' }

export function FlavorPanel() {
  const data = useProjectStore((s) => s.data)
  const activeId = useUIStore((s) => s.activeId)
  const busy = useUIStore((s) => s.stream != null)
  const [openRule, setOpenRule] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const baselines = useBaselineStore((s) => s.store)
  useBaselineStore((s) => s.revision)
  // 命令行可能新建了基线：打开面板时重读一遍
  useEffect(() => void useBaselineStore.getState().load(), [])
  if (!data) return null
  const ui = () => useUIStore.getState()
  const report = flavorReport(data)
  const genreSetting = data.meta.flavor?.genre ?? 'auto'
  const ignored = data.meta.flavor?.ignore?.length ?? 0
  const activeHits = activeId ? (report.blocks.find((b) => b.block === activeId)?.hits ?? []) : []
  const worst = report.blocks
    .filter((b) => b.hits.length && (b.index ?? 0) > 0)
    .sort((a, b) => (b.index ?? 0) - (a.index ?? 0))
    .slice(0, 8)
  const counted = report.rules.filter((r) => r.count > 0)
  const clean = !report.hits.length && !report.findings.length

  const locate = (id: string) => {
    ui().requestLocate(id)
    ui().setActive(id)
  }
  const firstBlockOf = (rule: string) => report.blocks.find((b) => b.hits.some((h) => h.rule === rule))?.block

  return (
    <aside className="suggestions-panel flavor-panel" aria-label="AI 味">
      <div className="suggestions-header">
        <span>AI 味</span>
        <button className="icon-btn" onClick={() => ui().setFlavorOpen(false)} title="关闭" aria-label="关闭">
          <IconX />
        </button>
      </div>
      <div className="suggestions-list">
        <section className={`flavor-score level-${report.level}`} aria-label="AI 味指数">
          <div className="flavor-index">{report.index ?? '—'}</div>
          <div className="flavor-score-text">
            <div className="flavor-level">{report.level}</div>
            <div className="flavor-sub">
              {report.baseline === '内置' ? '相对内置的人类基线' : `相对「${report.baseline}」的基线`} · {report.chars} 字
            </div>
          </div>
        </section>
        <div className="flavor-baseline">
          <span>基线</span>
          <select
            value={data.meta.flavor?.baseline ?? ''}
            onChange={(e) => setFlavorBaseline(e.target.value || null)}
            aria-label="基线"
          >
            <option value="">默认（{baselines.default ?? '内置人类基线'}）</option>
            <option value={BUILTIN}>内置人类基线</option>
            {baselines.baselines.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}（{b.chars} 字）
              </option>
            ))}
          </select>
          <button className="link-btn" onClick={() => setBuilding(true)}>
            建立我的基线…
          </button>
        </div>
        {building && <BaselineModal onClose={() => setBuilding(false)} />}
        <div className="flavor-genre">
          <SegmentedControl<Genre | 'auto'>
            value={genreSetting}
            items={[
              { value: 'auto', label: genreSetting === 'auto' ? `自动·${GENRE_LABEL[report.genre]}` : '自动' },
              { value: 'fiction', label: '小说' },
              { value: 'essay', label: '文章' },
              { value: 'general', label: '通用' },
            ]}
            onChange={(g) => setFlavorGenre(g)}
            ariaLabel="文体"
          />
        </div>
        <p className="flavor-note">指数是超出基线的程度，不是"AI 写的概率"。标出的只是嫌疑，改不改由你定。</p>

        {activeHits.length > 0 && activeId && (
          <section className="suggestion-card flavor-active" aria-label="这一段的命中">
            <div className="flavor-section-title">这一段</div>
            {activeHits.map((h, i) => (
              <HitRow key={`${h.rule}:${h.start}:${i}`} hit={h} />
            ))}
            <div className="actions">
              <button className="btn btn-primary" disabled={busy} onClick={() => void deflavorBlock(activeId)}>
                去 AI 味
              </button>
            </div>
          </section>
        )}

        {clean ? (
          <div className="suggestions-empty">没有发现明显的 AI 腔。</div>
        ) : (
          <>
            {counted.length > 0 && (
              <section aria-label="按规则">
                <div className="flavor-section-title">按规则</div>
                {counted.map((r) => {
                  const rule = RULE_BY_ID.get(r.rule)
                  const target = firstBlockOf(r.rule)
                  const open = openRule === r.rule
                  return (
                    <div key={r.rule} className={`flavor-rule${r.penalty > 0 ? ' over' : ''}`}>
                      <button className="flavor-rule-head" onClick={() => setOpenRule(open ? null : r.rule)} aria-expanded={open}>
                        <span className={`flavor-dot sev-${r.severity}`} aria-hidden />
                        <span className="flavor-rule-name">{r.name}</span>
                        <span className="flavor-rule-count">{r.count} 处</span>
                        <span className="flavor-rule-density" title="每万字出现次数 / 允许的次数">
                          {r.density} / {r.allowance}
                        </span>
                      </button>
                      {open && rule && (
                        <div className="flavor-rule-body">
                          <p>{rule.why}</p>
                          <p>
                            <b>改法：</b>
                            {rule.advice}
                          </p>
                          <p className="flavor-source">依据：{rule.source}</p>
                          {target && (
                            <button className="link-btn" onClick={() => locate(target)}>
                              看第一处
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </section>
            )}

            {report.findings.length > 0 && (
              <section aria-label="整篇">
                <div className="flavor-section-title">整篇</div>
                {report.findings.map((f) => (
                  <div key={f.id + f.detail} className="flavor-finding">
                    <span className={`flavor-dot sev-${f.severity}`} aria-hidden />
                    <span>
                      <b>{f.name}</b>：{f.detail}
                    </span>
                  </div>
                ))}
              </section>
            )}

            {worst.length > 0 && (
              <section aria-label="最该先改的段落">
                <div className="flavor-section-title">最该先改的段落</div>
                {worst.map((b) => (
                  <div key={b.block} className="flavor-block">
                    <button className="flavor-block-text" onClick={() => locate(b.block)}>
                      <span className={`flavor-badge level-${b.level}`}>{b.index}</span>
                      {(getBlock(data, b.block)?.text ?? '').slice(0, 48)}
                    </button>
                    <button className="btn btn-plain" disabled={busy} onClick={() => void deflavorBlock(b.block)}>
                      去 AI 味
                    </button>
                  </div>
                ))}
              </section>
            )}
          </>
        )}

        {ignored > 0 && (
          <div className="flavor-ignored">
            已忽略 {ignored} 处
            <button className="link-btn" onClick={clearFlavorIgnores}>
              全部恢复
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

function HitRow({ hit }: { hit: FlavorHit }) {
  const rule = RULE_BY_ID.get(hit.rule)
  return (
    <div className="flavor-hit">
      <div className="flavor-hit-head">
        <span className={`flavor-dot sev-${hit.severity}`} aria-hidden />
        <span className="flavor-hit-quote">「{hit.text}」</span>
        <span className="flavor-hit-name">
          {hit.name} · {SEVERITY_LABEL[hit.severity]}
        </span>
      </div>
      {rule && <div className="flavor-hit-advice">{rule.advice}</div>}
      {rule && (
        <button className="link-btn" onClick={() => ignoreFlavorHit(hit)} title="这处是有意为之：之后不再标出，agent 也不会再报">
          这处没问题
        </button>
      )}
    </div>
  )
}

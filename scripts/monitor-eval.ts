// Which AI model writes the most accurate live updates? Builds the REAL facts for a session once, then asks each
// candidate model to write the update N times and grades every draft with the monitor's own fact check.
//   npx tsx --conditions=react-server scripts/monitor-eval.ts S-CODE [runs]
import { getSession } from '../lib/sessions/store'
import { buildFacts } from '../lib/monitor/tick'
import { checkDraft, SYSTEM, forAi } from '../lib/monitor/check'

const MODELS = (process.env.MODELS ?? 'openai/gpt-oss-20b,nvidia/nemotron-3-ultra-550b-a55b,moonshotai/kimi-k3').split(',')
const code = process.argv[2] ?? 'S-0D52E6', RUNS = Number(process.argv[3] ?? 3)
const base = process.env.NVIDIA_BASE_URL?.trim() || 'https://integrate.api.nvidia.com/v1', key = process.env.NVIDIA_API_KEY!.trim()

async function ask(model: string, user: string) {
  const t0 = Date.now()
  const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], temperature: 0.3, max_tokens: 600 }), signal: AbortSignal.timeout(90_000) })
  const j = await r.json() as { choices?: { message?: { content?: string } }[]; detail?: string }
  return { text: (j.choices?.[0]?.message?.content ?? '').trim(), ms: Date.now() - t0, err: r.ok ? null : `${r.status} ${String(j.detail ?? '').slice(0, 60)}` }
}

async function main() {
  const s = await getSession(code); if (!s) throw new Error('no session')
  const prev = ((s.meta ?? {}) as { monitor?: { last?: never } }).monitor?.last
  const { facts } = await buildFacts(s, prev, { site: false })
  console.log(`facts: ${facts.jackpot.aliveNow}/${facts.jackpot.total} alive, ${facts.jackpot.chancePct}%, ${facts.live.length} live, floor ${facts.floor.won}/${facts.floor.lost}/${facts.floor.open}\n`)
  const user = JSON.stringify(forAi(facts))
  for (const m of MODELS) {
    let pass = 0, ms = 0, n = 0; const notes: string[] = []; let sample = ''
    for (let i = 0; i < RUNS; i++) {
      const r = await ask(m, user).catch(e => ({ text: '', ms: 90_000, err: String(e).slice(0, 60) }))
      n++; ms += r.ms
      if (r.err || !r.text) { notes.push(r.err ?? 'empty'); continue }
      const issues = checkDraft(r.text, facts)
      if (!issues.length) { pass++; sample ||= r.text } else notes.push(issues.join('; ').slice(0, 90))
    }
    console.log(`${m.padEnd(40)} accurate ${pass}/${n} · avg ${(ms / n / 1000).toFixed(1)}s${notes.length ? ` · failures: ${[...new Set(notes)].slice(0, 2).join(' | ')}` : ''}`)
    if (sample) console.log(`   e.g. "${sample.replace(/\s+/g, ' ').slice(0, 260)}"`)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

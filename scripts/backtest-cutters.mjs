/**
 * scripts/backtest-cutters.mjs — the one measurement that decides if PEDLA v3 is real (pedlas_v3.md §7).
 *
 * A "cutter" = a game that finishes Over 4.5 (home+away ≥ 5). PEDLA stakes all-Under slips and wins
 * whenever a slip avoids every cutter; the covering design guarantees ≥1 winning slip iff the real
 * cutter count c ≤ the budgeted depth C. So the whole edge-free premise reduces to: **how is c
 * distributed per slate, and is P(c ≤ 3) high and stable?**
 *
 * Source: match_history (home_goals, away_goals, match_date). We group by day into "slates".
 * CAVEAT: match_history has no historical odds, so we can't apply the real "Under 4.5 @ ≥1.20"
 * filter. Un-priced games skew slightly toward high totals (the book prices those <1.20 and PEDLA
 * would skip them), so this is a mild UPPER bound on c — the real, odds-filtered c is a touch lower.
 *
 *   node scripts/backtest-cutters.mjs [minPool=10]
 */
import { readFileSync, writeFileSync } from 'node:fs'

for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const ref = (process.env.SUPABASE_URL || '').replace(/^https?:\/\//, '').split('.')[0]
const pat = process.env.SUPABASE_ACCESS
const MIN_POOL = Number(process.argv[2] || 10)

async function sql(q) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }),
  })
  const t = await r.text()
  if (!r.ok) throw new Error(`SQL ${r.status}: ${t.slice(0, 300)}`)
  return JSON.parse(t)
}

// nCr and Binomial tail, for the independence comparison
const logFact = (() => { const c = [0, 0]; return n => { for (let i = c.length; i <= n; i++) c[i] = c[i - 1] + Math.log(i); return c[n] } })()
const logC = (n, k) => (k < 0 || k > n) ? -Infinity : logFact(n) - logFact(k) - logFact(n - k)
const binomAtMost = (n, k, p) => { let s = 0; for (let i = 0; i <= k; i++) s += Math.exp(logC(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p)); return s }

const pct = x => (100 * x).toFixed(1) + '%'

async function main() {
  const rows = await sql(`select match_date, home_goals, away_goals from match_history where home_goals is not null and away_goals is not null`)
  if (rows.length === 0) { console.log('match_history is empty — run the ETL (POST /api/pedlas/history/sync) first.'); return }

  // base rate: P(single game Over 4.5)
  const totals = rows.map(r => Number(r.home_goals) + Number(r.away_goals))
  const p = totals.filter(t => t >= 5).length / totals.length

  // group into daily slates
  const byDay = new Map()
  for (const r of rows) {
    const d = String(r.match_date).slice(0, 10)
    const arr = byDay.get(d) ?? []; arr.push(Number(r.home_goals) + Number(r.away_goals)); byDay.set(d, arr)
  }
  const slates = [...byDay.entries()]
    .map(([day, ts]) => ({ day, N: ts.length, c: ts.filter(t => t >= 5).length }))
    .filter(s => s.N >= MIN_POOL)
    .sort((a, b) => b.c - a.c)

  const nSlates = slates.length
  const atMost = k => slates.filter(s => s.c <= k).length / nSlates
  const meanC = slates.reduce((a, s) => a + s.c, 0) / nSlates
  const meanN = slates.reduce((a, s) => a + s.N, 0) / nSlates
  const varC = slates.reduce((a, s) => a + (s.c - meanC) ** 2, 0) / nSlates

  console.log('\nPEDLA cutter backtest (Over 4.5 = total goals ≥ 5)')
  console.log('─'.repeat(64))
  console.log(`matches: ${rows.length}   ·  Over-4.5 base rate p = ${pct(p)}`)
  console.log(`slates (days with ≥${MIN_POOL} games): ${nSlates}   ·  mean pool N = ${meanN.toFixed(1)}`)
  console.log(`cutters per slate: mean ${meanC.toFixed(2)}, var ${varC.toFixed(2)} ` +
    `(var>mean ⇒ correlated/over-dispersed vs independent)`)
  console.log('')
  console.log('  EMPIRICAL             vs   INDEPENDENT (Binomial, N=33)')
  for (const k of [1, 2, 3, 4, 5]) {
    console.log(`  P(c ≤ ${k}) = ${pct(atMost(k)).padStart(6)}        ` +
      `Binom P(c ≤ ${k}) = ${pct(binomAtMost(33, k, p)).padStart(6)}`)
  }
  console.log('\n  worst slates (highest cutter count):')
  for (const s of slates.slice(0, 8)) console.log(`    ${s.day}  N=${String(s.N).padStart(3)}  c=${s.c}  (${pct(s.c / s.N)} of pool)`)

  console.log('\n  READ: if empirical P(c≤3) is high AND stable across seasons, depth-3 coverage (≈₦2,830')
  console.log('  in the worked example) profits on most slates. The gap vs Binomial is the correlation')
  console.log('  tax — high-scoring matchdays that lift many games at once. Size budget for the TAIL.\n')

  const out = 'backtest-cutters.json'
  writeFileSync(out, JSON.stringify({ p, meanN, meanC, varC, nSlates,
    pAtMost: Object.fromEntries([1, 2, 3, 4, 5].map(k => [k, atMost(k)])), slates }, null, 2))
  console.log(`  full data → ${out}`)
}
main().catch(e => { console.error('backtest:', e.message); process.exit(1) })

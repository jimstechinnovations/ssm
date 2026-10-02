// Compare budget plans on the LIVE board: jackpot slips at a chosen stake + an optional floor (Flexi
// tickets), built with today's bot, then simulated together (20,000 days, book-honest probabilities).
//   npx tsx --conditions=react-server scripts/plan-compare.ts [budget] [stake] [target] [floorShares]
import { sportybet } from '../lib/books/sportybet'
import { runDecisionBotAsync } from '../lib/pedlas/decision-bot'
import { fetchSportyBonusPlan, sportyBonus } from '../lib/books/sportybet-bonus'
import { loadPanel } from '../lib/books/panel'
import { consensus } from '../lib/books/reference'
import { buildFloor } from '../lib/pedlas/floor'
import { tableFromPicks } from '../lib/pedlas/survivors'
import { ruleWins, type Selection, type SelectionGame, type LegRule } from '../lib/pedlas/selections'

const budget = Number(process.argv[2] ?? 3000), stake = Number(process.argv[3] ?? 100), target = Number(process.argv[4] ?? 51000)
const shares = (process.argv[5] ?? '0,0.1,0.25,0.5').split(',').map(Number)
const naira = (n: number) => '₦' + Math.round(n).toLocaleString()
const pct = (p: number, d = 1) => `${(100 * p).toFixed(d)}%`

async function main() {
  const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
  const games = (await sportybet.fetchSelectionGames!({ dateFrom: d(0), dateTo: d(1), scanLimit: 250, minKickoffGapMinutes: 90 })).games
  const panel = await loadPanel(games)
  for (const g of games) for (const s of g.selections) { const c = consensus(panel.games.get(g.fixtureId), s.rule); if (c) s.sharp = c }
  const plan = await fetchSportyBonusPlan()
  const tour = new Map(games.flatMap(g => g.selections.map(s => [s, g.tournamentId] as const)))
  const bonusFn = (sels: Selection[]) => sportyBonus(sels.map(x => ({ odds: x.odds, probability: x.probability, margin: x.margin, tournamentId: tour.get(x) })), plan).perStake
  const P = (s: Selection) => s.sharp && s.sharp.n >= 2 && s.sharp.spread <= 0.04 ? s.sharp.p : (s.probability ?? 1 / (s.odds * 1.06))
  // one scoreline table per game, fitted to every pick's honest probability — the "truth" for the simulation
  const DAYS = 20000
  const ids = games.map(g => g.fixtureId), gi = new Map(ids.map((id, i) => [id, i]))
  const cdfs = games.map(g => { const t = tableFromPicks(g.selections.map(s => ({ rule: s.rule, p: P(s) }))); const c = new Float64Array(t.length); let a = 0; for (let i = 0; i < t.length; i++) { a += t[i]; c[i] = a } return c })
  let seed = 99; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  const cells = new Uint8Array(DAYS * ids.length)
  for (let dd = 0; dd < DAYS; dd++) for (let g = 0; g < ids.length; g++) { const c = cdfs[g], x = rnd() * c[c.length - 1]; let lo = 0, hi = c.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < x) lo = m + 1; else hi = m } cells[dd * ids.length + g] = lo }
  const right = (legs: { fixtureId: number; rule: LegRule }[], dd: number) => legs.filter(l => { const i = cells[dd * ids.length + gi.get(l.fixtureId)!]; return ruleWins(l.rule, Math.floor(i / 11), i % 11) }).length
  console.log(`${games.length} games (${d(0)}–${d(1)}) · panel ${panel.sources.map(s => `${s.source} ${s.matched}`).join(', ')} · plan: ${naira(budget)} · jackpot slips ${naira(stake)} → ${naira(target)} · floor tickets ₦10`)

  const rows: string[] = []
  for (const f of shares) {
    const jb = Math.round(budget * (1 - f))
    const r = await runDecisionBotAsync(games, { stake, target, budget: jb, rule: 'greedy', seed: 11, bonusFn, boost: sportybet.boostFor, maxPayout: sportybet.maxPayout, skip: true, maxLegs: 8, deadlineMs: 15 * 60_000, legProb: 'panel' })
    const jackpotFix = new Set(r.slips.flatMap(s => s.legs.map(l => r.games[l.game].fixtureId)))
    const fl = f > 0 ? buildFloor(games, { budget: budget - jb, stake: 10, avoidFixtures: jackpotFix, probOf: (_g: SelectionGame, s: Selection) => P(s) }).tickets : []
    const jLegs = r.slips.map(s => s.legs.map(l => ({ fixtureId: r.games[l.game].fixtureId, rule: l.selection.rule })))
    const total = new Float64Array(DAYS); let jackpotDays = 0
    for (let dd = 0; dd < DAYS; dd++) {
      let t = 0, hit = false
      r.slips.forEach((s, i) => { if (right(jLegs[i], dd) === jLegs[i].length) { t += s.payout; hit = true } })
      for (const tk of fl) if (right(tk.legs.map(l => ({ fixtureId: l.game.fixtureId, rule: l.sel.rule })), dd) >= tk.k) t += tk.payout
      total[dd] = t; if (hit) jackpotDays++
    }
    const a = Array.from(total).sort((x, y) => x - y), mean = a.reduce((x, y) => x + y, 0) / DAYS
    const ge = (x: number) => a.filter(v => v >= x).length / DAYS
    const staked = r.slips.length * stake + fl.length * 10
    const noJack = a.filter((_, i) => true)   // (kept simple: the median below is dominated by no-jackpot days)
    void noJack
    const legsN = r.slips.map(s => s.legs.length)
    console.log(`\n=== floor ${pct(f, 0)}: ${r.slips.length} jackpot slips (${Math.min(...legsN)}–${Math.max(...legsN)} legs, ₦${stake} each) + ${fl.length} floor tickets — staked ${naira(staked)}`)
    console.log(`  chance of ≥1 jackpot ${pct(jackpotDays / DAYS, 2)} · back per ₦1 ${(mean / staked).toFixed(3)} · expected loss ${naira(staked - mean)}`)
    console.log(`  money back on a typical day (median) ${naira(a[DAYS >> 1])} · ≥25% back ${pct(ge(staked * 0.25))} · ≥50% back ${pct(ge(staked * 0.5))} · ≥ budget back ${pct(ge(staked))}`)
    const s0 = r.slips[0]
    console.log(`  sample jackpot slip: ₦${stake} → ${naira(s0.payout)}, wins ${pct(s0.pWin, 3)} — ${s0.legs.map(l => `${l.selection.name} @${l.selection.odds}`).join(' · ')}`)
    if (fl[0]) console.log(`  sample floor ticket: ₦10 → ${naira(fl[0].payout)} if ≥${fl[0].k} of 8 — lands ${pct(fl[0].pWin, 0)} — ${fl[0].legs.map(l => `${l.sel.name} @${l.sel.odds}`).join(' · ')}`)
    rows.push(`${pct(f, 0).padStart(4)} | ${String(r.slips.length).padStart(2)} slips + ${String(fl.length).padStart(3)} tickets | jackpot ${pct(jackpotDays / DAYS, 2).padStart(6)} | back/₦1 ${(mean / staked).toFixed(3)} | median back ${naira(a[DAYS >> 1]).padStart(7)} | ≥50% back ${pct(ge(staked * 0.5)).padStart(6)}`)
  }
  console.log('\nSUMMARY\n' + rows.join('\n'))
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

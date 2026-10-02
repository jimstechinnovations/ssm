// scripts/flexi-study.ts — would SportyBet's near-miss products (Flexibet, One Cut) have helped, and how
// should a budget be split between "jackpot" and "floor"? Two parts, both on OUR real slips:
//
//  A. BACKTEST on real results: every placed Decision Bot slip whose games have all finished, re-priced as
//     Flexi "N−1 / N−2 / N−3 of N" and as One Cut, with SportyBet's exact formulas
//     (lib/books/sportybet-flexi.ts, verified to the kobo). What would each have actually returned?
//  B. SIMULATION: the same slips over 20,000 simulated days (per-game scoreline tables fitted to the legs'
//     calibrated probabilities, as lib/pedlas/survivors.ts does). Per strategy: expected return per ₦1,
//     chance of getting back ≥ the budget, ≥ half of it, and of a ≥ target jackpot.
//
// Leg probabilities are BOOK-HONEST: odds × P capped at 0.97 (a leg never returns more than the book's own
// fair price minus a thin margin; the live probe legs sat at 0.94–0.97). Our stored P comes from the fitted
// scoreline table, which overstates big underdogs (14% of legs had odds × P > 1, up to 1.40 on a "Home win
// @ 26") — uncapped, Flexi's odds-weighted formula turns that model error into a fake edge. The same capped
// P prices the tickets AND drives the simulation, so no product can look better than the book prices it.
// Read-only: uses the local app's API.
//
//   npx tsx scripts/flexi-study.ts [S-CODE ...] [--base http://localhost:3000]

import { ruleWins, type LegRule } from '../lib/pedlas/selections'
import { tableFromPicks } from '../lib/pedlas/survivors'
import { flexiOdds, oneCut } from '../lib/books/sportybet-flexi'

const args = process.argv.slice(2)
const BASE = (i => i >= 0 ? args[i + 1] : 'http://localhost:3000')(args.indexOf('--base'))
const CODES = args.filter(a => /^S-/.test(a))
const CAP = 0.97                                   // max odds × P per leg (book-honest)
const SESSIONS = CODES.length ? CODES : ['S-A1FA6F', 'S-2A4472', 'S-7A14B6', 'S-F2AA60', 'S-222131', 'S-3EC9BA', 'S-DB2F41']

type Leg = { fixtureId: number; rule?: LegRule; odds: number; p?: number; suspended?: boolean; game?: string }
type Slip = { code: string; slipId: number; stake: number; payout: number; legs: { fixtureId: number; rule: LegRule; odds: number; p: number }[] }
type Result = { finished: boolean; home: number | null; away: number | null }

const naira = (n: number) => '₦' + Math.round(n).toLocaleString()
const pct = (p: number, d = 1) => `${(100 * p).toFixed(d)}%`

async function load() {
  const slips: Slip[] = []
  const results = new Map<number, Result>()
  for (const code of SESSIONS) {
    const j = await (await fetch(`${BASE}/api/sessions/${code}?withLegs=1&limit=20000`)).json() as { slips?: { slipId: number; status: string; stake: number; potentialPayout: number | null; sitePayout?: number | null; legs?: Leg[] }[] }
    for (const s of j.slips ?? []) {
      if (!['placed', 'won', 'lost'].includes(s.status)) continue
      const legs = (s.legs ?? []).filter(l => !l.suspended && l.rule && l.odds > 1).map(l => ({ fixtureId: l.fixtureId, rule: l.rule!, odds: l.odds, p: Math.min(typeof l.p === 'number' && l.p > 0 ? l.p : 1 / (l.odds * 1.05), CAP / l.odds) }))
      if (legs.length >= 3) slips.push({ code, slipId: s.slipId, stake: s.stake, payout: s.sitePayout ?? s.potentialPayout ?? 0, legs })
    }
    const g = await (await fetch(`${BASE}/api/sessions/${code}/games`)).json() as { games?: { fixtureId: number; outcome?: { finished: boolean; home?: number | null; away?: number | null } | null }[] }
    for (const x of g.games ?? []) if (x.outcome) results.set(x.fixtureId, { finished: !!x.outcome.finished, home: x.outcome.home ?? null, away: x.outcome.away ?? null })
  }
  return { slips, results }
}

// what each product pays for a slip with `correct` legs right (N legs), per ₦ of its own stake
function payPerStake(s: Slip, correct: number, product: string): number {
  const N = s.legs.length, legs = s.legs.map(l => ({ odds: l.odds, probability: l.p }))
  const plain = s.payout / s.stake                       // includes the bonus, as placed
  if (product === 'none') return 0                       // slip not bought (its stake went elsewhere)
  if (product === 'plain') return correct === N ? plain : 0
  const m = /^flexi-(\d)$/.exec(product)
  if (m) { const k = N - Number(m[1]); return correct >= k ? flexiOdds(legs, k).odds : 0 }
  const oc = /^onecut(?:-(\d+))?$/.exec(product)
  if (oc) {
    const O = s.legs.reduce((x, l) => x * l.odds, 1)
    const r = oneCut({ stake: 1, oddsProduct: O, bonusAmount: plain - O, cutOdds: flexiOdds(legs, N - 1).odds, sliderPct: oc[1] ? Number(oc[1]) / 100 : undefined })
    return correct === N ? r.allWin : correct === N - 1 ? r.oneCutWin : 0
  }
  throw new Error(product)
}

const PRODUCTS = ['plain', 'onecut', 'onecut-50', 'flexi-1', 'flexi-2', 'flexi-3']
const ALL_PRODUCTS = [...PRODUCTS, 'none']

async function main() {
  const { slips, results } = await load()
  const budget = slips.reduce((x, s) => x + s.stake, 0)
  const target = Math.max(...slips.map(s => s.payout))
  console.log(`\n${slips.length} placed Decision Bot slips from ${SESSIONS.length} sessions · budget ${naira(budget)} · biggest payout ${naira(target)}`)

  // ── A. backtest on real results ──
  const fin = (fixtureId: number) => { const r = results.get(fixtureId); return r?.finished && r.home != null ? r : null }
  const done = slips.filter(s => s.legs.every(l => fin(l.fixtureId)))
  const correctOf = (s: Slip) => s.legs.filter(l => { const r = fin(l.fixtureId); return r && ruleWins(l.rule, r.home!, r.away!) }).length
  const missedSoFar = (s: Slip) => s.legs.filter(l => { const r = fin(l.fixtureId); return r && !ruleWins(l.rule, r.home!, r.away!) }).length
  const hist = new Map<number, number>()
  for (const s of done) { const miss = s.legs.length - correctOf(s); hist.set(miss, (hist.get(miss) ?? 0) + 1) }
  const doneStake = done.reduce((x, s) => x + s.stake, 0)
  console.log(`\nA. REAL RESULTS — ${done.length} slips with every game finished (staked ${naira(doneStake)})`)
  console.log('   legs missed per slip: ' + [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([m, n]) => `${m} missed: ${n}`).join(' · '))
  for (const prod of PRODUCTS) {
    let ret = 0, paid = 0, best = 0
    for (const s of done) { const r = s.stake * payPerStake(s, correctOf(s), prod); ret += r; if (r > 0) { paid++; best = Math.max(best, r) } }
    console.log(`   ${prod.padEnd(10)} returned ${naira(ret).padStart(8)} of ${naira(doneStake)} (${pct(ret / doneStake, 0).padStart(4)}) · ${String(paid).padStart(3)} tickets paid · best ${naira(best)}`)
  }
  // every slip, including ones with games still to play: already beyond what a product forgives = a loss
  const forgives: Record<string, number> = { plain: 0, onecut: 1, 'onecut-50': 1, 'flexi-1': 1, 'flexi-2': 2, 'flexi-3': 3 }
  console.log(`   — all ${slips.length} slips (₦${budget}): already lost under each product, or still open`)
  for (const prod of PRODUCTS) {
    const dead = slips.filter(s => missedSoFar(s) > forgives[prod]).length
    console.log(`   ${prod.padEnd(10)} already lost ${String(dead).padStart(3)} · still open ${String(slips.length - dead).padStart(3)}`)
  }

  // ── B. simulation over the same slips ──
  const DAYS = 20000
  const games = [...new Set(slips.flatMap(s => s.legs.map(l => l.fixtureId)))]
  const gIdx = new Map(games.map((g, i) => [g, i]))
  const picks = new Map<number, { rule: LegRule; p: number; odds: number }[]>()
  for (const s of slips) for (const l of s.legs) { const a = picks.get(l.fixtureId) ?? []; a.push({ rule: l.rule, p: l.p, odds: l.odds }); picks.set(l.fixtureId, a) }
  const cdfs = games.map(g => { const t = tableFromPicks(picks.get(g) ?? []); const c = new Float64Array(t.length); let a = 0; for (let i = 0; i < t.length; i++) { a += t[i]; c[i] = a } return c })
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  const cells = new Uint8Array(DAYS * games.length)                 // the simulated final score of every game, every day
  for (let d = 0; d < DAYS; d++) for (let gi = 0; gi < games.length; gi++) { const c = cdfs[gi], x = rnd() * c[c.length - 1]; let lo = 0, hi = c.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (c[mid] < x) lo = mid + 1; else hi = mid } cells[d * games.length + gi] = lo }
  const correctOn = (legs: { fixtureId: number; rule: LegRule }[], d: number) => legs.filter(l => { const i = cells[d * games.length + gIdx.get(l.fixtureId)!]; return ruleWins(l.rule, Math.floor(i / 11), i % 11) }).length
  const correct = slips.map(s => Uint8Array.from({ length: DAYS }, (_, d) => correctOn(s.legs, d)))
  const payTable = (prod: string) => slips.map(s => Array.from({ length: s.legs.length + 1 }, (_, c) => s.stake * payPerStake(s, c, prod)))
  const tables = new Map(ALL_PRODUCTS.map(p => [p, payTable(p)]))
  /** per-day total return when slip i uses product choose(i) */
  const run = (choose: (i: number) => string, extra?: Float64Array) => { const t = new Float64Array(DAYS); for (let i = 0; i < slips.length; i++) { const pt = tables.get(choose(i))!, ci = correct[i]; for (let d = 0; d < DAYS; d++) t[d] += pt[i][ci[d]] } if (extra) for (let d = 0; d < DAYS; d++) t[d] += extra[d]; return t }
  const report = (label: string, t: Float64Array, spend: number) => {
    const a = Array.from(t).sort((x, y) => x - y), mean = a.reduce((x, y) => x + y, 0) / DAYS, ge = (x: number) => a.filter(v => v >= x).length / DAYS
    console.log(`   ${label.padEnd(34)} ${('₦' + (mean / spend).toFixed(3)).padStart(7)}   ${pct(ge(spend)).padStart(6)}   ${pct(ge(spend * 0.75)).padStart(6)}   ${pct(ge(spend / 2)).padStart(6)}   ${pct(ge(50000), 2).padStart(6)}   ${naira(a[DAYS >> 1]).padStart(7)}`)
  }
  const head = () => console.log('   strategy (same ₦' + budget + ')                back/₦1  ≥budget  ≥75%    ≥half   jackpot  median')
  console.log(`\nB. SIMULATED — the same ${slips.length} slips, ${DAYS.toLocaleString()} days, budget ${naira(budget)}`)
  head()
  for (const p of PRODUCTS) report(`every slip as ${p}`, run(() => p), budget)

  // (a) send a share of the bot's slips to Flexi N−3, keep the rest plain (₦10 minimum stake: whole slips)
  console.log('\n   (a) a share of the bot slips as Flexi N−3, the rest plain')
  head()
  for (const f of [0, 0.1, 0.25, 0.5]) { const every = f ? Math.round(1 / f) : 0; report(`${pct(f, 0)} of slips → Flexi N−3`, run(i => every && i % every === 0 ? 'flexi-3' : 'plain'), budget) }

  // (b) a separate FLOOR: Flexi tickets on LIKELY legs (the most probable pick per game, odds ≥ 1.20), 8 legs,
  // each at the tightest "k of 8" that still wins ≥ 45% of the time. SportyBet's key is the full L (≈ the
  // legs' own return, ~0.95) whenever P(≥ k) ≥ L^(1/(1−L)) ≈ 0.36, so these return the most per ₦1.
  const likely = games.map(g => (picks.get(g) ?? []).filter(x => x.odds >= 1.2).reduce<{ rule: LegRule; p: number; odds: number } | null>((b, x) => (!b || x.p > b.p ? x : b), null))
  const pool = games.map((g, gi) => ({ gi, leg: likely[gi] })).filter(x => x.leg).sort((x, y) => y.leg!.p - x.leg!.p)
  const floorTickets: { legs: { fixtureId: number; rule: LegRule; odds: number; p: number }[]; k: number; odds: number; key: number }[] = []
  for (let t = 0; t < 400 && pool.length >= 8; t++) {
    const pickIdx = [...new Set(Array.from({ length: 8 }, (_, j) => (t * 5 + j * 13) % pool.length))]
    if (pickIdx.length < 8) continue
    const legs = pickIdx.map(i => ({ fixtureId: games[pool[i].gi], ...pool[i].leg! }))
    const fl = legs.map(l => ({ odds: l.odds, probability: l.p }))
    let k = 8; while (k > 1 && flexiOdds(fl, k).pAtLeast < 0.45) k--
    const o = flexiOdds(fl, k)
    floorTickets.push({ legs, k, odds: o.odds, key: o.key })
  }
  const avg = (f: (x: typeof floorTickets[number]) => number) => floorTickets.reduce((x, t) => x + f(t), 0) / floorTickets.length
  console.log(`\n   (b) a FLOOR layer: ${floorTickets.length} Flexi tickets on likely legs (avg leg P ${pct(avg(t => t.legs.reduce((x, l) => x + l.p, 0) / 8), 0)}), "≥ ${avg(t => t.k).toFixed(1)} of 8" — returns ≈ ₦${avg(t => t.key).toFixed(3)} per ₦1, pays ≈ ${avg(t => t.odds).toFixed(2)}× stake when it lands`)
  // the same floor recipe against REAL results: tickets built only from games that have finished
  const finPool = pool.filter(x => fin(games[x.gi]))
  let rStake = 0, rRet = 0, rPaid = 0
  for (let t = 0; t < 400 && finPool.length >= 8; t++) {
    const idx = [...new Set(Array.from({ length: 8 }, (_, j) => (t * 5 + j * 13) % finPool.length))]
    if (idx.length < 8) continue
    const legs = idx.map(i => ({ fixtureId: games[finPool[i].gi], ...finPool[i].leg! }))
    const fl = legs.map(l => ({ odds: l.odds, probability: l.p }))
    let k = 8; while (k > 1 && flexiOdds(fl, k).pAtLeast < 0.45) k--
    const o = flexiOdds(fl, k)
    rStake += 10; if (correctOf({ legs } as Slip) >= k) { rRet += 10 * o.odds; rPaid++ }
  }
  console.log(`   real results: ${rStake / 10} floor tickets from ${finPool.length} finished games → staked ${naira(rStake)}, returned ${naira(rRet)} (${pct(rRet / Math.max(1, rStake), 0)}), ${rPaid} paid`)
  head()
  for (const f of [0, 0.1, 0.25, 0.5]) {
    const nFloor = Math.round(f * slips.length), stake = slips[0].stake
    const extra = new Float64Array(DAYS)
    for (let t = 0; t < nFloor; t++) { const tk = floorTickets[t % floorTickets.length]; for (let d = 0; d < DAYS; d++) if (correctOn(tk.legs, d) >= tk.k) extra[d] += stake * tk.odds }
    const every = f ? Math.round(1 / f) : 0
    report(`${pct(f, 0)} of budget → floor tickets`, run(i => (every && i % every === 0 ? 'none' : 'plain'), extra), budget)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

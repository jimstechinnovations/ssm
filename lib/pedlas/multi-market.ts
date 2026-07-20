// lib/pedlas/multi-market.ts
// Multi-market total-goals coverage (the "scoreline-band" design). Each game is a 3-band axis:
//   LOW  = 0–2 goals  (Under 2.5)
//   MID  = 3–4 goals  (both Under 4.5 AND Over 2.5 win — the overlap)
//   HIGH = 5+ goals   (Over 4.5)
// Markets a slip can bet per game and the bands they cover:
//   Under 2.5 → {LOW}          Under 4.5 → {LOW,MID}
//   Over 2.5  → {MID,HIGH}     Over 4.5  → {HIGH}
// A slip picks one market per included game (variable leg count) and WINS iff every game's realised
// band is covered by its market. The realizer covers the most-frequent realistic band-vectors.
//
// HONESTY: the per-slip keep-rate (EV) is computed under the BOOK's own pricing = INDEPENDENCE, so it
// can never be faked by assuming an unpriced correlation (the trap that made an earlier probe show a
// fake +₦16M). keep = (1+boost) · ∏(deVigP·odds) = (1+boost)/∏(1+margin) — always < 1 (−vig). The
// correlated sim only shapes P(≥1 win); it never touches the EV. No market mix removes the vig.

import 'server-only'
import type { Fixture, OddsValue } from './types'
import { boostFor, type BoostFn } from './boost'

export type Band = 0 | 1 | 2                     // 0=LOW 1=MID 2=HIGH
export type Market = 'U25' | 'U45' | 'O25' | 'O45'
const COVERS: Record<Market, Band[]> = { U25: [0], U45: [0, 1], O25: [1, 2], O45: [2] }
const coversBand = (m: Market, b: Band) => COVERS[m].includes(b)

export interface MultiAxis {
  fixtureId: number; game: string; league: string; kickoff: string
  pLOW: number; pMID: number; pHIGH: number       // de-vigged band probabilities (independent marginals)
  odds: Record<Market, number>                    // book odds per market
  marginAvg: number                               // avg two-way margin across the 2.5 & 4.5 lines
}

const devig = (u: number, o: number) => { const iu = 1 / u, io = 1 / o, s = iu + io; return { pU: iu / s, pO: io / s, margin: s - 1 } }
function lineOdds(odds: OddsValue[], l: number) {
  let u: number | null = null, o: number | null = null
  for (const x of odds) { if (x.market !== `OVER_UNDER_${l}`) continue; const t = x.label.toLowerCase(); if (t.startsWith('under')) u = x.value; else if (t.startsWith('over')) o = x.value }
  return u && o && u > 1 && o > 1 ? { u, o } : null
}

/** Build 3-band axes for games where Under 4.5 @ ≥minOdds AND the 2.5 line is priced. */
export function buildMultiAxes(fixtures: Fixture[], minUnder45 = 1.20): MultiAxis[] {
  const out: MultiAxis[] = []
  for (const fx of fixtures) {
    const m45 = lineOdds(fx.odds, 4.5), m25 = lineOdds(fx.odds, 2.5)
    if (!m45 || !m25 || m45.u < minUnder45) continue
    const d45 = devig(m45.u, m45.o), d25 = devig(m25.u, m25.o)
    const pHIGH = d45.pO, pLOW = d25.pU, pMID = Math.max(0.01, 1 - pHIGH - pLOW)
    out.push({
      fixtureId: fx.id, game: `${fx.homeTeam} vs ${fx.awayTeam}`, league: fx.league, kickoff: fx.kickoff,
      pLOW, pMID, pHIGH, marginAvg: (d45.margin + d25.margin) / 2,
      odds: { U25: m25.u, U45: m45.u, O25: m25.o, O45: m45.o },
    })
  }
  return out
}

// ── deterministic RNG + 3-band correlated day draw (common shock) ──
function mulberry32(seed: number) { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
function gauss(rng: () => number) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }
function probit(p: number): number { const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00],b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01],c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00],dd=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00],pl=0.02425; if(p<pl){const q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1)} if(p>1-pl){const q=Math.sqrt(-2*Math.log(1-p));return-(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1)} const q=p-0.5,r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1) }

export interface MultiSlip { markets: Market[]; games: number[]; legs: number; combinedOdds: number; payout: number; keep: number }
export interface MultiBook {
  slips: MultiSlip[]
  N: number; K: number
  pAnyWin: number            // P(≥1 slip wins) under the correlated day model
  keepRate: number           // HONEST family EV/₦ under independence (book pricing) — always < 1
  expectedNet: number        // (keepRate−1)·budget
  medianPayout: number
  note: string
}

/**
 * Build the multi-market coverage book. Base = fewest highest-Under-4.5-odds games to reach `target`.
 * Realizer: simulate correlated 3-band days; a game that lands MID is "free" (both U45 & O25 win), so
 * we cover the most-frequent {which games are LOW vs HIGH} decisive patterns — U45 on non-HIGH, O25 on
 * HIGH. Variable legs: drop the lowest-odds games from a slip while its payout still clears `target`
 * (the operator's "drop to fit ₦target" idea). Every slip's keep is computed under independence (honest).
 */
export function buildMultiBook(axes: MultiAxis[], opts: { budget: number; stake: number; target: number; maxPayout: number; boost?: BoostFn; rho?: number; trials?: number; seed?: number }): MultiBook {
  const { budget, stake, target, maxPayout } = opts
  const boost = opts.boost ?? boostFor
  const rho = opts.rho ?? 0.15
  const K = Math.max(1, Math.floor(budget / stake))
  // base games: fewest highest-Under-4.5-odds to reach target on the all-Under-4.5 parlay
  const sorted = [...axes].sort((a, b) => b.odds.U45 - a.odds.U45)
  let N = 3, prod = 1
  for (N = 1; N <= Math.min(45, sorted.length); N++) { prod *= sorted[N - 1].odds.U45; if (stake * prod * (1 + boost(N)) >= target) break }
  N = Math.min(Math.max(N, 6), sorted.length, 45)
  const G = sorted.slice(0, N)

  const tH = G.map(g => probit(1 - Math.min(0.98, Math.max(0.02, g.pHIGH))))
  const tL = G.map(g => probit(Math.min(0.98, Math.max(0.02, g.pLOW))))
  const rng = mulberry32(opts.seed ?? 0xC0FFEE)
  const drawDay = () => { const z = gauss(rng); const o = new Array<Band>(N); for (let i = 0; i < N; i++) { const x = Math.sqrt(rho) * z + Math.sqrt(1 - rho) * gauss(rng); o[i] = (x > tH[i] ? 2 : x <= tL[i] ? 0 : 1) as Band } return o }

  // tally most-frequent HIGH-sets (the decisive O25 games); MID free, LOW → U45
  const trials = opts.trials ?? 60000
  const cnt = new Map<string, number>(); const hset = new Map<string, number[]>()
  for (let t = 0; t < trials; t++) { const o = drawDay(); const H: number[] = []; for (let i = 0; i < N; i++) if (o[i] === 2) H.push(i); const k = H.join(','); cnt.set(k, (cnt.get(k) || 0) + 1); if (!hset.has(k)) hset.set(k, H) }
  const topH = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, K).map(([k]) => hset.get(k)!)

  // honest per-slip keep under INDEPENDENCE: keep = (1+boost(L))·∏(deVigP_side · odds_side)
  const bandProbOf = (g: MultiAxis, m: Market) => { let s = 0; for (const band of COVERS[m]) s += band === 0 ? g.pLOW : band === 1 ? g.pMID : g.pHIGH; return s }
  const buildSlip = (H: Set<number>): MultiSlip => {
    // start with all N games: O25 on H, U45 elsewhere
    let games = G.map((_, i) => i)
    let markets: Market[] = games.map(i => (H.has(i) ? 'O25' : 'U45'))
    // variable legs — drop the lowest-odds games while payout still clears target (the trim idea)
    const oddsOf = (i: number, m: Market) => G[i].odds[m]
    let odds = games.reduce((p, i, j) => p * oddsOf(i, markets[j]), 1)
    let pay = Math.min(stake * odds * (1 + boost(games.length)), maxPayout)
    // drop candidates: lowest-odds legs first, keep dropping while still ≥ target
    const order = [...games].sort((x, y) => oddsOf(x, H.has(x) ? 'O25' : 'U45') - oddsOf(y, H.has(y) ? 'O25' : 'U45'))
    for (const dropIdx of order) {
      if (games.length <= 4) break
      const test = games.filter(i => i !== dropIdx)
      const testMk = test.map(i => (H.has(i) ? 'O25' : 'U45') as Market)
      const tOdds = test.reduce((p, i, j) => p * oddsOf(i, testMk[j]), 1)
      const tPay = Math.min(stake * tOdds * (1 + boost(test.length)), maxPayout)
      if (tPay >= target) { games = test; markets = testMk; odds = tOdds; pay = tPay } else break
    }
    // honest keep (independence)
    let keep = 1 + boost(games.length)
    for (let j = 0; j < games.length; j++) keep *= bandProbOf(G[games[j]], markets[j]) * oddsOf(games[j], markets[j])
    return { markets, games: games.map(i => G[i].fixtureId), legs: games.length, combinedOdds: odds, payout: Math.round(pay), keep }
  }
  const slips = topH.map(H => buildSlip(new Set(H)))

  // family measurement: honest EV (independence) + P(≥1 win) (correlated). To be safe against the
  // correlation-fakes-profit trap, EV is the mean of per-slip independent keeps — never the sim.
  const keepRate = slips.reduce((s, x) => s + x.keep, 0) / slips.length
  const winSlip = (sl: MultiSlip, o: Band[]) => sl.games.every((fid, j) => { const gi = G.findIndex(g => g.fixtureId === fid); return coversBand(sl.markets[j], o[gi]) })
  let hits = 0; const T = Math.min(30000, opts.trials ?? 30000)
  for (let t = 0; t < T; t++) { const o = drawDay(); if (slips.some(sl => winSlip(sl, o))) hits++ }
  const pAnyWin = hits / T
  const pays = slips.map(s => s.payout).sort((a, b) => a - b)
  return {
    slips, N, K, pAnyWin, keepRate: +keepRate.toFixed(4),
    expectedNet: Math.round((keepRate - 1) * budget),
    medianPayout: pays[Math.floor(pays.length / 2)] || 0,
    note: `multi-market (U2.5/U4.5/O2.5/O4.5), ${N}-game base, variable legs to ₦${target}. HONEST keep=${keepRate.toFixed(3)} (<1 = −vig, computed under book independence, not the sim).`,
  }
}

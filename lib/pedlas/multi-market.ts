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
import type { Fixture, OddsValue, PedlasSlip, PedlasLeg } from './types'
import { boostFor, type BoostFn } from './boost'

export type Band = 0 | 1 | 2                     // 0=LOW 1=MID 2=HIGH
export type Market = 'U25' | 'U45' | 'O25' | 'O45'
const COVERS: Record<Market, Band[]> = { U25: [0], U45: [0, 1], O25: [1, 2], O45: [2] }
/** Which total-goals line + side each market bets (so it maps onto the standard leg + booking code). */
const MK: Record<Market, { line: number; side: 'Under' | 'Over' }> = {
  U25: { line: 2.5, side: 'Under' }, U45: { line: 4.5, side: 'Under' }, O25: { line: 2.5, side: 'Over' }, O45: { line: 4.5, side: 'Over' },
}
/** P(this market wins for a game) under the book's independent marginals. */
export function bandProb(a: MultiAxis, m: Market): number { let s = 0; for (const b of COVERS[m]) s += b === 0 ? a.pLOW : b === 1 ? a.pMID : a.pHIGH; return s }

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
  rho: number                // correlation the slips were chosen + priced under (0 = the book's own independent pricing)
  /** STRESS figure only: P(≥1 win) if games were as correlated as the backtest suggests (ρ calibrated to
   *  var/mean≈1.7). Not the headline — taken at face value it implies +EV, which the book's prices contradict. */
  pAnyWinCorrelated: number
  rhoStress: number
  expectedNet: number        // (keepRate−1)·budget
  medianPayout: number
  note: string
}

export interface MultiBookOptions {
  budget: number; stake: number; target: number; maxPayout: number; boost?: BoostFn
  /** Correlation used to CHOOSE and PRICE the slips. Default 0 = the bookmaker's own pricing (games
   *  independent), so the reported P(≥1 win) is consistent with the keep-rate: P(≥1 win)·target ≤ keep·budget.
   *  A correlated ρ inflates P(win) several-fold (an implied +EV the book's prices don't support), so it is
   *  reported separately as a stress figure (pAnyWinCorrelated), never as the headline. */
  rho?: number
  trials?: number; seed?: number
  /** 'greedy' (default): pick each slip to win on the most simulated days not already covered — the
   *  P(≥1 win)-maximising choice. 'sampled': the older one-slip-per-random-day mix (kept for comparison). */
  select?: 'greedy' | 'sampled'
}

const popcnt = (x: number) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24 }

/** Correlation ρ at which the count of HIGH (5+) games per simulated day has var/mean ≈ `ratio`. */
export function calibrateRho(pHigh: number[], ratio = 1.7, days = 3000, seed = 0xBADC0DE): number {
  const tH = pHigh.map(p => probit(1 - Math.min(0.98, Math.max(0.02, p))))
  const disp = (rho: number) => {
    const rng = mulberry32(seed); let s = 0, s2 = 0
    for (let d = 0; d < days; d++) { const z = gauss(rng); let c = 0; for (const t of tH) if (Math.sqrt(rho) * z + Math.sqrt(1 - rho) * gauss(rng) > t) c++; s += c; s2 += c * c }
    const m = s / days; return m > 0 ? (s2 / days - m * m) / m : 1
  }
  let lo = 0, hi = 0.6
  if (disp(hi) < ratio) return hi
  if (disp(lo) >= ratio) return lo
  for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (disp(mid) < ratio) lo = mid; else hi = mid }
  return +((lo + hi) / 2).toFixed(3)
}

/**
 * Build the multi-market coverage book. Base = fewest highest-Under-4.5-odds games to reach `target`.
 * Candidates: each simulated correlated 3-band day proposes the slip that fits it (every game bet on the
 * market covering its sampled band — tight or wide), trimmed to the fewest legs that still pay ≥ target.
 * Selection (greedy, default): repeatedly take the candidate that wins on the MOST simulated days no chosen
 * slip wins yet (maximum coverage ⇒ P(≥1 win) as high as this candidate set allows). P(≥1 win) is then
 * measured on a FRESH, independent set of days (out-of-sample — never scored on the days it was fitted to).
 * Every slip's keep is computed under independence (the book's pricing — honest, always < 1).
 */
export function buildMultiBook(axes: MultiAxis[], opts: MultiBookOptions): MultiBook {
  const { budget, stake, target, maxPayout } = opts
  const boost = opts.boost ?? boostFor
  const K = Math.max(1, Math.floor(budget / stake))
  const select = opts.select ?? 'greedy'
  // base games: fewest highest-Under-4.5-odds to reach target; then STABLE order (kickoff, then game
  // name) so the game list — and therefore the coverage tree — is deterministic run to run.
  const sorted = [...axes].sort((a, b) => b.odds.U45 - a.odds.U45)
  let N = 3, prod = 1
  for (N = 1; N <= Math.min(45, sorted.length); N++) { prod *= sorted[N - 1].odds.U45; if (stake * prod * (1 + boost(N)) >= target) break }
  N = Math.min(Math.max(N, 6), sorted.length, 45)
  const G = sorted.slice(0, N).sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.game.localeCompare(b.game))

  const rho = opts.rho ?? 0
  const rhoStress = calibrateRho(G.map(g => g.pHIGH))
  const tH = G.map(g => probit(1 - Math.min(0.98, Math.max(0.02, g.pHIGH))))
  const tL = G.map(g => probit(Math.min(0.98, Math.max(0.02, g.pLOW))))
  const dayDrawer = (seed: number, r = rho) => { const rng = mulberry32(seed); return () => { const z = gauss(rng); const o = new Array<Band>(N); for (let i = 0; i < N; i++) { const x = Math.sqrt(r) * z + Math.sqrt(1 - r) * gauss(rng); o[i] = (x > tH[i] ? 2 : x <= tL[i] ? 0 : 1) as Band } return o } }
  const drawDay = dayDrawer(opts.seed ?? 0xC0FFEE)

  // The market that FITS a game's sampled band, from that game's own prices:
  //   HIGH (5+) → Over 4.5 (tight) / Over 2.5 (wide) · LOW (0-2) → Under 2.5 (tight) / Under 4.5 (wide)
  //   MID (3-4) → the game's likelier wide side (Under 4.5 if it leans low, Over 2.5 if it leans high)
  const oddsOf = (i: number, m: Market) => G[i].odds[m]
  const fit = (i: number, b: Band, tight: boolean): Market =>
    b === 2 ? (tight ? 'O45' : 'O25')
      : b === 0 ? (tight && G[i].pLOW >= 0.4 ? 'U25' : 'U45')
        : (G[i].pLOW >= G[i].pHIGH ? 'U45' : 'O25')
  const buildSampled = (bands: Band[], tight: boolean): MultiSlip | null => {
    let games = G.map((_, i) => i)
    const mk = new Map<number, Market>(games.map(i => [i, fit(i, bands[i], tight)]))
    let odds = games.reduce((p, i) => p * oddsOf(i, mk.get(i)!), 1)
    let pay = Math.min(stake * odds * (1 + boost(games.length)), maxPayout)
    if (pay < target) return null   // every slip must pay ≥ target when it wins
    // variable legs — drop the lowest-odds legs while payout still clears target
    const byOdds = [...games].sort((a, b) => oddsOf(a, mk.get(a)!) - oddsOf(b, mk.get(b)!))
    for (const drop of byOdds) {
      if (games.length <= 4) break
      const test = games.filter(i => i !== drop)
      const tOdds = test.reduce((p, i) => p * oddsOf(i, mk.get(i)!), 1)
      const tPay = Math.min(stake * tOdds * (1 + boost(test.length)), maxPayout)
      if (tPay >= target) { games = test; odds = tOdds; pay = tPay } else break
    }
    const markets = games.map(i => mk.get(i)!)
    let keep = 1 + boost(games.length)
    for (const i of games) keep *= bandProb(G[i], mk.get(i)!) * oddsOf(i, mk.get(i)!)
    return { markets, games: games.map(i => G[i].fixtureId), legs: games.length, combinedOdds: odds, payout: Math.round(pay), keep }
  }
  const keyOf = (sl: MultiSlip) => sl.games.map((g, j) => g + sl.markets[j]).join('|')
  const gi = new Map(G.map((g, i) => [g.fixtureId, i]))

  const slips: MultiSlip[] = []
  if (select === 'sampled') {
    const seen = new Set<string>()
    for (let guard = 0; slips.length < K && guard < K * 20; guard++) {
      const sl = buildSampled(drawDay(), slips.length % 3 === 1)
      if (!sl) continue
      const key = keyOf(sl); if (seen.has(key)) continue
      seen.add(key); slips.push(sl)
    }
  } else {
    // ── candidates: tight + wide slip for many sampled days (deduped) ──
    const cand: MultiSlip[] = []; const seen = new Set<string>()
    for (let guard = 0; cand.length < K * 4 && guard < K * 40; guard++) {
      const day = drawDay()
      for (const tight of [false, true]) { const sl = buildSampled(day, tight); if (!sl) continue; const k = keyOf(sl); if (!seen.has(k)) { seen.add(k); cand.push(sl) } }
    }
    // ── training days → per-(game, market) win bitsets → per-candidate win bitsets ──
    const D = 6144, W = D >>> 5
    const train = dayDrawer((opts.seed ?? 0xC0FFEE) ^ 0x5EED)
    const bandBits: Uint32Array[][] = G.map(() => [new Uint32Array(W), new Uint32Array(W), new Uint32Array(W)])
    for (let d = 0; d < D; d++) { const o = train(); for (let i = 0; i < N; i++) bandBits[i][o[i]][d >>> 5] |= 1 << (d & 31) }
    const mktBits = (i: number, m: Market) => { const out = new Uint32Array(W); for (const b of COVERS[m]) { const bb = bandBits[i][b]; for (let w = 0; w < W; w++) out[w] |= bb[w] } return out }
    const cache = new Map<string, Uint32Array>()
    const bits = cand.map(sl => {
      const acc = new Uint32Array(W).fill(0xFFFFFFFF)
      sl.games.forEach((fid, j) => { const i = gi.get(fid)!; const ck = i + sl.markets[j]; let mb = cache.get(ck); if (!mb) { mb = mktBits(i, sl.markets[j]); cache.set(ck, mb) } for (let w = 0; w < W; w++) acc[w] &= mb[w] })
      return acc
    })
    // ── lazy greedy max-coverage (gains only shrink, so a stale upper bound is safe to re-check) ──
    const covered = new Uint32Array(W)
    const gain = (c: number) => { let g = 0; const b = bits[c]; for (let w = 0; w < W; w++) g += popcnt(b[w] & ~covered[w]); return g }
    const ub = bits.map((_, c) => gain(c))
    const taken = new Uint8Array(cand.length)
    const order = cand.map((_, c) => c)
    const better = (a: number, b: number) => ub[a] > ub[b] || (ub[a] === ub[b] && cand[a].keep > cand[b].keep)
    while (slips.length < K && slips.length < cand.length) {
      order.sort((a, b) => (ub[b] - ub[a]) || (cand[b].keep - cand[a].keep))
      // Scan in upper-bound order; once no remaining bound can beat the best FRESH gain, stop — exact argmax.
      // Ties (incl. once every simulated day is covered) go to the higher-keep slip (loses least).
      let pick = -1
      for (const c of order) {
        if (taken[c]) continue
        if (pick >= 0 && ub[c] < ub[pick]) break
        ub[c] = gain(c)
        if (pick < 0 || better(c, pick)) pick = c
      }
      if (pick < 0) break
      taken[pick] = 1; slips.push(cand[pick])
      const b = bits[pick]; for (let w = 0; w < W; w++) covered[w] |= b[w]
    }
  }

  // family measurement: honest EV (independence) + P(≥1 win) on FRESH days (out-of-sample, correlated).
  // EV is the mean of per-slip independent keeps — never the sim (the correlation-fakes-profit trap).
  const keepRate = slips.length ? slips.reduce((s, x) => s + x.keep, 0) / slips.length : 0
  const compiled = slips.map(sl => sl.games.map((fid, j) => ({ i: gi.get(fid)!, cover: COVERS[sl.markets[j]] })))
  const winC = (c: { i: number; cover: Band[] }[], o: Band[]) => { for (const { i, cover } of c) if (!cover.includes(o[i])) return false; return true }
  const evalDay = dayDrawer((opts.seed ?? 0xC0FFEE) ^ 0xE7A1)
  let hits = 0; const T = Math.min(20000, opts.trials ?? 20000)
  for (let t = 0; t < T; t++) { const o = evalDay(); for (const c of compiled) if (winC(c, o)) { hits++; break } }
  const pAnyWin = hits / T
  // stress: same slips on correlated days (see MultiBook.pAnyWinCorrelated)
  const stressDay = dayDrawer((opts.seed ?? 0xC0FFEE) ^ 0x57E5, rhoStress)
  let stressHits = 0; const TS = Math.min(10000, T)
  for (let t = 0; t < TS; t++) { const o = stressDay(); for (const c of compiled) if (winC(c, o)) { stressHits++; break } }
  const pAnyWinCorrelated = stressHits / TS
  const pays = slips.map(s => s.payout).sort((a, b) => a - b)
  const mix: Record<Market, number> = { U25: 0, U45: 0, O25: 0, O45: 0 }
  for (const s of slips) for (const m of s.markets) mix[m]++
  const legs = slips.map(s => s.legs)
  return {
    slips, N, K, pAnyWin, keepRate: +keepRate.toFixed(4), rho, pAnyWinCorrelated, rhoStress,
    expectedNet: Math.round((keepRate - 1) * Math.min(budget, slips.length * stake)),
    medianPayout: pays[Math.floor(pays.length / 2)] || 0,
    note: `multi-market ${select === 'greedy' ? 'max-coverage' : 'sampled'} mix over ${N} games (priced as the book prices: games independent): legs ${Math.min(...legs)}-${Math.max(...legs)}, market legs U2.5:${mix.U25} U4.5:${mix.U45} O2.5:${mix.O25} O4.5:${mix.O45}. HONEST keep=${keepRate.toFixed(3)} (<1 = −vig, independence-priced).`,
  }
}

/** Convert a MultiBook into standard PedlasSlips (legs carry the right line/side, so settlement,
 *  booking codes and the UI all work unchanged). trueProb/keep computed under independence (honest). */
export function toPedlasSlips(book: MultiBook, axes: MultiAxis[], stake: number, maxPayout: number, boost: BoostFn): PedlasSlip[] {
  const byId = new Map(axes.map(a => [a.fixtureId, a]))
  return book.slips.map((s, k) => {
    const legs: PedlasLeg[] = s.games.map((fid, j) => {
      const a = byId.get(fid)!; const m = s.markets[j]; const { line, side } = MK[m]
      return { fixtureId: fid, game: a.game, league: a.league, kickoff: a.kickoff, line, side, market: `OVER_UNDER_${line}`, outcome: `${side} ${line}`, odds: a.odds[m] }
    })
    let trueProb = 1
    for (let j = 0; j < s.games.length; j++) trueProb *= bandProb(byId.get(s.games[j])!, s.markets[j])
    const uncapped = stake * s.combinedOdds * (1 + boost(s.legs))
    return {
      slipId: k + 1, vector: s.markets.map(m => (m[0] === 'O' ? 1 : 0)) as (0 | 1)[], legs, legCount: s.legs,
      combinedOdds: s.combinedOdds, trueProb, boostPct: boost(s.legs) * 100, stake,
      payout: s.payout, uncappedPayout: uncapped, capped: uncapped > s.payout, evMultiple: s.keep, rankScore: 0,
    }
  })
}

// lib/pedlas/scoreline-table.ts
// A per-game scoreline table (P of every final score 0–0 … 10–10) CALIBRATED to the bookmaker's own
// prices: after fitting, every selection's probability equals its de-vigged price (within ~0.5pt).
//
// Why calibrate: a plain Poisson fit disagrees with the book on some markets (it under-rates draws), and
// an optimiser then "finds" selections that look better than fair — pure model error (algorithm_v1 §5).
// With a calibrated table every selection's keep = P × odds = 1/(1+margin) < 1: the bot can only choose
// between honestly-priced options, never chase our own modelling mistakes.
//
// Method: independent-Poisson start (λ grid fitted to Home / Away / Over 2.5), then iterative
// proportional fitting (IPF) over every two-sided pair: scale the cells a selection wins on to its
// de-vigged probability, the complementary cells to the rest; repeat until all pairs agree.

import { ruleWins, type Selection } from './selections'

export const MAX_GOALS = 10
const N = MAX_GOALS + 1

export interface ScorelineTable {
  p: Float64Array            // p[h*N + a]
  maxError: number           // worst |P(selection) − de-vigged price| after calibration
  lambdaHome: number
  lambdaAway: number
}

const pois = (l: number, k: number) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p }

/** The book's de-vigged probability of a selection (its pair's margin removed proportionally). */
export function devigged(sel: Selection, all: Selection[]): number {
  const flip = all.find(s => s.key === sel.flipKey)
  if (!flip) return 1 / sel.odds
  return (1 / sel.odds) / (1 / sel.odds + 1 / flip.odds)
}

/** P(rule wins) under the table. */
export function probOf(t: ScorelineTable, sel: Selection): number {
  let s = 0
  for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) if (ruleWins(sel.rule, h, a)) s += t.p[h * N + a]
  return s
}

export function calibrateTable(sels: Selection[], iterations = 400, tol = 0.002): ScorelineTable {
  const target = (name: string) => { const s = sels.find(x => x.name === name); return s ? devigged(s, sels) : null }
  const tH = target('Home win'), tA = target('Away win'), tO = target('Over 2.5')
  // 1) Poisson start on whatever anchors exist: a coarse λ grid, then a fine grid around the best point
  //    (only a starting point — IPF below does the real fitting, so ~0.02 precision is plenty).
  let best = { err: Infinity, lh: 1.4, la: 1.1 }
  const fitErr = (lh: number, la: number) => {
    const ph = Array.from({ length: N }, (_, k) => pois(lh, k)), pa = Array.from({ length: N }, (_, k) => pois(la, k))
    let pH = 0, pA = 0, pO = 0
    for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) { const p = ph[h] * pa[a]; if (h > a) pH += p; else if (a > h) pA += p; if (h + a > 2.5) pO += p }
    return (tH == null ? 0 : (pH - tH) ** 2) + (tA == null ? 0 : (pA - tA) ** 2) + (tO == null ? 0 : (pO - tO) ** 2)
  }
  for (let lh = 0.2; lh <= 4; lh += 0.2) for (let la = 0.2; la <= 4; la += 0.2) { const err = fitErr(lh, la); if (err < best.err) best = { err, lh, la } }
  const c = best
  for (let lh = Math.max(0.05, c.lh - 0.2); lh <= c.lh + 0.2; lh += 0.02) for (let la = Math.max(0.05, c.la - 0.2); la <= c.la + 0.2; la += 0.02) { const err = fitErr(lh, la); if (err < best.err) best = { err, lh, la } }
  const p = new Float64Array(N * N)
  for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) p[h * N + a] = pois(best.lh, h) * pois(best.la, a)
  const norm = () => { let s = 0; for (const v of p) s += v; for (let i = 0; i < p.length; i++) p[i] /= s }
  norm()

  // 2) IPF over one selection per pair (its flip is the complement, so one side fixes both)
  const seen = new Set<string>()
  const cons = sels.filter(s => { if (seen.has(s.flipKey)) return false; seen.add(s.key); return true })
    .map(s => ({ q: devigged(s, sels), mask: Uint8Array.from({ length: N * N }, (_, i) => ruleWins(s.rule, Math.floor(i / N), i % N) ? 1 : 0) }))
  let maxError = 1
  for (let it = 0; it < iterations && maxError > tol / 4; it++) {
    maxError = 0
    for (const c of cons) {
      // measure BOTH sides directly (never assume they sum to 1 — a near-certain selection leaves a
      // tiny complement, and 1 − pin would amplify rounding error until the table explodes)
      let pin = 0, pout = 0
      for (let i = 0; i < p.length; i++) if (c.mask[i]) pin += p[i]; else pout += p[i]
      const tot = pin + pout
      maxError = Math.max(maxError, Math.abs(pin / tot - c.q))
      if (pin <= 1e-12 || pout <= 1e-12) continue
      const fin = c.q / pin, fout = (1 - c.q) / pout
      for (let i = 0; i < p.length; i++) p[i] *= c.mask[i] ? fin : fout
    }
  }
  // final error, measured after the last sweep
  maxError = 0
  for (const c of cons) { let pin = 0; for (let i = 0; i < p.length; i++) if (c.mask[i]) pin += p[i]; maxError = Math.max(maxError, Math.abs(pin - c.q)) }
  return { p, maxError, lambdaHome: best.lh, lambdaAway: best.la }
}

/** Cumulative table for sampling scorelines: returns a sampler u∈[0,1) → [h, a]. */
export function scorelineSampler(t: ScorelineTable): (u: number) => [number, number] {
  const cdf = new Float64Array(t.p.length); let s = 0
  for (let i = 0; i < t.p.length; i++) { s += t.p[i]; cdf[i] = s }
  return (u: number) => {
    const x = u * s; let lo = 0, hi = cdf.length - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < x) lo = mid + 1; else hi = mid }
    return [Math.floor(lo / N), lo % N]
  }
}

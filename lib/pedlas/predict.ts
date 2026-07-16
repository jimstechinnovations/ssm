// lib/pedlas/predict.ts
// Match-history → expected goals (λ) → p̂(market). Pure, no I/O.
//
// Improvement over the naive season-average model (which went 3/3 wrong on the 26 Jun CSL slate,
// see pedlas_v2.md §1): recency-WEIGHTED team form (recent matches count more) + per-team
// attack/defence relative to the league. p̂ is an INDEPENDENT estimate; it is only trustworthy once
// backtested as calibrated (see backtest below) — never assume it beats the book.

import { poissonDist, pMarket } from './scoreline-model'
import { resolveMarket } from './fingerprint'
import type { FpMarket } from './fingerprint'

export interface MatchResult {
  date: string   // ISO or YYYY-MM-DD; used only for ordering / as-of filtering
  home: string
  away: string
  hg: number     // home goals
  ag: number     // away goals
}

export interface LambdaEstimate {
  lambdaHome: number
  lambdaAway: number
  nHome: number  // prior matches found for the home team
  nAway: number
}

export interface PredictOptions {
  halfLifeMatches?: number  // recency half-life (default 5): older matches decay
  window?: number           // max recent matches per team (default 12)
  maxGoals?: number         // Poisson grid truncation (default 12)
}

function poissonPmf(k: number, lambda: number): number {
  let fact = 1
  for (let i = 2; i <= k; i++) fact *= i
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fact
}

/** P(total goals > line) under independent Poisson(λ_home), Poisson(λ_away). Line is X.5. */
export function pHatOver(lambdaHome: number, lambdaAway: number, line: number, maxGoals = 12): number {
  let pUnder = 0
  for (let h = 0; h <= maxGoals; h++) {
    const ph = poissonPmf(h, lambdaHome)
    for (let a = 0; a <= maxGoals; a++) {
      if (h + a <= line) pUnder += ph * poissonPmf(a, lambdaAway)
    }
  }
  return Math.max(0, Math.min(1, 1 - pUnder))
}

/** Recency-weighted expected goals for a fixture, using only matches strictly before `asOf`. */
export function estimateLambdas(
  history: MatchResult[],
  home: string,
  away: string,
  asOf: string,
  opts: PredictOptions = {},
): LambdaEstimate {
  const halfLife = opts.halfLifeMatches ?? 5
  const window = opts.window ?? 12

  const prior = history.filter(m => m.date < asOf)
  let lgHF = 0, lgAF = 0, n = 0
  for (const m of prior) { lgHF += m.hg; lgAF += m.ag; n++ }
  const leagueHome = n ? lgHF / n : 1.4
  const leagueAway = n ? lgAF / n : 1.1
  const leagueAvg = (leagueHome + leagueAway) / 2 || 1.25

  function form(team: string) {
    const ms = prior.filter(m => m.home === team || m.away === team).slice(-window)
    let wScored = 0, wConceded = 0, wsum = 0
    ms.forEach((m, i) => {
      const w = Math.pow(2, (i - (ms.length - 1)) / halfLife) // most recent = weight 1, older decays
      wScored   += w * (m.home === team ? m.hg : m.ag)
      wConceded += w * (m.home === team ? m.ag : m.hg)
      wsum += w
    })
    return wsum > 0
      ? { att: wScored / wsum, def: wConceded / wsum, n: ms.length }
      : { att: leagueAvg, def: leagueAvg, n: 0 }
  }

  const H = form(home), A = form(away)
  return {
    lambdaHome: leagueHome * (H.att / leagueAvg) * (A.def / leagueAvg),
    lambdaAway: leagueAway * (A.att / leagueAvg) * (H.def / leagueAvg),
    nHome: H.n,
    nAway: A.n,
  }
}

/** Convenience: p̂(Over line) for a fixture from history. */
export function predictOver(
  history: MatchResult[],
  home: string,
  away: string,
  asOf: string,
  line: number,
  opts: PredictOptions = {},
): { pOver: number; lambdas: LambdaEstimate } {
  const lambdas = estimateLambdas(history, home, away, asOf, opts)
  return { pOver: pHatOver(lambdas.lambdaHome, lambdas.lambdaAway, line, opts.maxGoals ?? 12), lambdas }
}

// ── Backtest scoring (pure) ──────────────────────────────────────────────────────
// Walk-forward over dated results: for each match (after a warmup) predict from PRIOR matches only,
// then score against the actual outcome. Reports calibration vs a base-rate baseline.

export interface BacktestResult {
  line: number
  n: number               // graded matches
  baseRate: number        // observed P(Over line)
  brierModel: number      // mean (p̂ − actual)²  (lower = better)
  brierBaseline: number   // baseline = always predict the base rate
  skill: number           // 1 − brierModel/brierBaseline  (>0 ⇒ model adds info)
  logLossModel: number
  calibration: { bucket: string; predicted: number; observed: number; n: number }[]
}

export function backtest(
  history: MatchResult[],
  line: number,
  opts: PredictOptions & { warmupMatches?: number } = {},
): BacktestResult {
  const warmup = opts.warmupMatches ?? 30
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date))
  const preds: { p: number; actual: number }[] = []

  for (let i = warmup; i < sorted.length; i++) {
    const m = sorted[i]
    const { pOver, lambdas } = predictOver(sorted.slice(0, i), m.home, m.away, m.date, line, opts)
    if (lambdas.nHome < 3 || lambdas.nAway < 3) continue // not enough history for either team
    preds.push({ p: pOver, actual: (m.hg + m.ag) > line ? 1 : 0 })
  }

  const n = preds.length
  const baseRate = n ? preds.reduce((s, x) => s + x.actual, 0) / n : 0
  const brierModel = n ? preds.reduce((s, x) => s + (x.p - x.actual) ** 2, 0) / n : 0
  const brierBaseline = n ? preds.reduce((s, x) => s + (baseRate - x.actual) ** 2, 0) / n : 0
  const eps = 1e-9
  const logLossModel = n
    ? -preds.reduce((s, x) => s + (x.actual ? Math.log(x.p + eps) : Math.log(1 - x.p + eps)), 0) / n
    : 0

  const edges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.01]
  const calibration = edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1]
    const inb = preds.filter(x => x.p >= lo && x.p < hi)
    return {
      bucket: `${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}%`,
      predicted: inb.length ? inb.reduce((s, x) => s + x.p, 0) / inb.length : 0,
      observed: inb.length ? inb.reduce((s, x) => s + x.actual, 0) / inb.length : 0,
      n: inb.length,
    }
  }).filter(b => b.n > 0)

  return {
    line, n, baseRate, brierModel, brierBaseline,
    skill: brierBaseline > 0 ? 1 - brierModel / brierBaseline : 0,
    logLossModel, calibration,
  }
}

// ── Multi-market backtest ──────────────────────────────────────────────────────
// Same walk-forward, but for ANY fingerprint market (BTTS, 1X2, Double Chance, O/U lines …)
// via the existing scoreline-model (λ → joint Poisson grid → pMarket) + fingerprint resolver.

export interface MarketBacktest {
  market: string
  n: number
  baseRate: number   // observed P(market resolves)
  brierModel: number
  brierBaseline: number
  skill: number      // 1 − brierModel/brierBaseline (>0 ⇒ model beats base rate)
  logLoss: number
}

export function backtestMarket(
  history: MatchResult[],
  market: FpMarket,
  opts: PredictOptions & { warmupMatches?: number } = {},
): MarketBacktest {
  const warmup = opts.warmupMatches ?? 30
  const maxGoals = opts.maxGoals ?? 10
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date))
  const preds: { p: number; actual: number }[] = []

  for (let i = warmup; i < sorted.length; i++) {
    const m = sorted[i]
    const lam = estimateLambdas(sorted.slice(0, i), m.home, m.away, m.date, opts)
    if (lam.nHome < 3 || lam.nAway < 3) continue
    const dist = poissonDist(lam.lambdaHome, lam.lambdaAway, maxGoals)
    const p = pMarket(dist, market)
    preds.push({ p, actual: resolveMarket(market, { home: m.hg, away: m.ag }) ? 1 : 0 })
  }

  const n = preds.length
  const baseRate = n ? preds.reduce((s, x) => s + x.actual, 0) / n : 0
  const brierModel = n ? preds.reduce((s, x) => s + (x.p - x.actual) ** 2, 0) / n : 0
  const brierBaseline = n ? preds.reduce((s, x) => s + (baseRate - x.actual) ** 2, 0) / n : 0
  const eps = 1e-9
  const logLoss = n
    ? -preds.reduce((s, x) => s + (x.actual ? Math.log(x.p + eps) : Math.log(1 - x.p + eps)), 0) / n
    : 0
  return { market, n, baseRate, brierModel, brierBaseline, skill: brierBaseline > 0 ? 1 - brierModel / brierBaseline : 0, logLoss }
}

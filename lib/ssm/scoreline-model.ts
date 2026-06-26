// lib/ssm/scoreline-model.ts
// A coherent per-game scoreline distribution. This is what makes the fingerprint
// meaningful: every market probability for a game is read off ONE distribution,
// so within-game correlations (e.g. Over 2.5 and BTTS) are respected — unlike
// de-vigging each market independently.
//
// Prototype assumption: independent Poisson goals (home ~ Pois(lh), away ~ Pois(la)).
// Good enough to demonstrate; swap for Dixon-Coles later.

import type { FpMarket, Scoreline } from './fingerprint'
import { resolveMarket } from './fingerprint'

export interface ScoreEntry { s: Scoreline; p: number }
export type ScorelineDist = ScoreEntry[]

function poissonPmf(k: number, lambda: number): number {
  let fact = 1
  for (let i = 2; i <= k; i++) fact *= i
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fact
}

/** Independent-Poisson scoreline distribution, normalised over the truncated grid. */
export function poissonDist(lambdaHome: number, lambdaAway: number, maxGoals = 6): ScorelineDist {
  const dist: ScorelineDist = []
  let total = 0
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway)
      dist.push({ s: { home: h, away: a }, p })
      total += p
    }
  }
  for (const e of dist) e.p /= total
  return dist
}

/** P(market resolves) = sum of scoreline probabilities where it resolves Yes. */
export function pMarket(dist: ScorelineDist, m: FpMarket): number {
  let p = 0
  for (const e of dist) if (resolveMarket(m, e.s)) p += e.p
  return p
}

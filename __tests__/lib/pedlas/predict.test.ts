// __tests__/lib/pedlas/predict.test.ts
// Deterministic (seeded) tests: the math is sound and the model extracts real signal when it exists.

import { describe, it, expect } from 'vitest'
import type { MatchResult } from '../../../lib/pedlas/predict'
import { pHatOver, estimateLambdas, predictOver, backtest } from '../../../lib/pedlas/predict'

describe('predict — math sanity', () => {
  it('pHatOver rises with λ and stays in [0,1]', () => {
    const lo = pHatOver(1.0, 1.0, 4.5)
    const hi = pHatOver(3.0, 3.0, 4.5)
    expect(hi).toBeGreaterThan(lo)
    for (const p of [lo, hi, pHatOver(2, 2, 5.5), pHatOver(0.5, 0.5, 6.5)]) {
      expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThanOrEqual(1)
    }
    // higher line ⇒ lower Over probability
    expect(pHatOver(2, 2, 5.5)).toBeLessThan(pHatOver(2, 2, 4.5))
  })

  it('estimateLambdas reflects recent form', () => {
    const hist: MatchResult[] = []
    // "Goals FC" scores heavily; "Bore FC" is goalless — over many recent matches.
    for (let i = 0; i < 10; i++) {
      hist.push({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, home: 'Goals FC', away: `X${i}`, hg: 4, ag: 1 })
      hist.push({ date: `2026-02-${String(i + 1).padStart(2, '0')}`, home: 'Bore FC', away: `Y${i}`, hg: 0, ag: 0 })
    }
    const goals = estimateLambdas(hist, 'Goals FC', 'Z', '2026-03-01')
    const bore = estimateLambdas(hist, 'Bore FC', 'Z', '2026-03-01')
    expect(goals.lambdaHome).toBeGreaterThan(bore.lambdaHome)
  })
})

// ── seeded synthetic league: persistent team strengths + Poisson goals ─────────────
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function poissonSample(lambda: number, rnd: () => number): number {
  const L = Math.exp(-lambda); let k = 0, p = 1
  do { k++; p *= rnd() } while (p > L)
  return k - 1
}

describe('predict — backtest extracts signal on a synthetic league', () => {
  it('beats the base-rate baseline (positive skill) when team strengths are real', () => {
    const rnd = mulberry32(42)
    const teams = Array.from({ length: 12 }, (_, i) => `T${i}`)
    const atk: Record<string, number> = {}, def: Record<string, number> = {}
    teams.forEach((t, i) => { atk[t] = 0.6 + (i % 6) * 0.22; def[t] = 0.6 + ((i * 5) % 6) * 0.18 })

    const history: MatchResult[] = []
    let day = 0
    for (let round = 0; round < 14; round++) {
      for (let i = 0; i < teams.length; i += 2) {
        const home = teams[i], away = teams[(i + 1 + round) % teams.length]
        if (home === away) continue
        const lh = 1.5 * atk[home] * def[away], la = 1.1 * atk[away] * def[home]
        day++
        history.push({
          date: `2026-${String(1 + Math.floor(day / 28)).padStart(2, '0')}-${String(1 + (day % 28)).padStart(2, '0')}`,
          home, away, hg: poissonSample(lh, rnd), ag: poissonSample(la, rnd),
        })
      }
    }

    const r = backtest(history, 2.5, { warmupMatches: 24 })
    expect(r.n).toBeGreaterThan(20)
    expect(r.brierModel).toBeLessThan(r.brierBaseline) // model adds information
    expect(r.skill).toBeGreaterThan(0)
    // discrimination: highest-prediction bucket observes more Overs than the lowest
    const withN = r.calibration.filter(b => b.n >= 3)
    if (withN.length >= 2) expect(withN[withN.length - 1].observed).toBeGreaterThan(withN[0].observed)

    // sanity: a fixture between two strong-attack teams predicts higher Over than two weak ones
    const strong = predictOver(history, 'T5', 'T11', '2027-01-01', 2.5).pOver
    const weak = predictOver(history, 'T0', 'T6', '2027-01-01', 2.5).pOver
    expect(strong).toBeGreaterThan(weak)
  })
})

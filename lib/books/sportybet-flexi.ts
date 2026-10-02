// lib/books/sportybet-flexi.ts
// SportyBet's near-miss products, computed EXACTLY as the betslip computes them. Decoded from the site's own
// betslip code (core.js: the Flexibet pricer `k()` and One Cut's stake split) and verified to the kobo
// against a real betslip on 2026-10-02 (8 legs, ₦100: Flexi 8/7/6/5/4-of-8 paid 49,578.37 / 4,926.08 /
// 1,052.69 / 367.88 / 183.62; One Cut at the 99% slider paid 5,410.80 all-win / 4,876.82 one-cut).
//
// FLEXIBET "at least k of N correct" (no Multi Bet Bonus):
//   F    = P(≥ k of N win) using SportyBet's OWN outcome probabilities (outcomeInfo.probability — the same
//          margin-free numbers the bonus formula uses), legs independent (Poisson-binomial)
//   L    = max(minRtp, Σ odds²·p ÷ Σ odds)              the legs' odds-weighted return (minRtp = 0.8)
//   key  = min(L, F^(multiplier·(1 − L)))                multiplier = 1.0 (live config)
//   odds = key ÷ F                                       payout = stake × odds (capped at max win)
// The config's per-size `oddsKeys` table (8 legs → 0.8) is the fallback key when the weighted-RTP mode is
// off; on the live site it is on, and `key` above is what the betslip shows.
//
// ONE CUT (stake S, plain odds O, bonus amount B, A = Flexi(N−1 of N) odds, cut share p of the stake):
//   d = (O·S + B) ÷ S                                    effective all-win odds incl. bonus
//   default p = max(S/A, S·(A−1)/(d+A−2)); with the slider p = pct·S (1%–99%)
//   one leg lost → A·p          all legs win → d·(S−p) + A·p          (both capped at max win)
// i.e. One Cut is a plain accumulator (with bonus) on S−p plus a Flexi(N−1) on p, as one ticket.
//
// Why it matters: the key sits near ONE leg's return (≈ 0.95), not the compounded margin of N legs, so a
// loose Flexi ticket returns more per ₦1 than a plain accumulator — but the key shrinks as F^(1−L) as the
// ticket gets less likely, so a big-target Flexi returns LESS than a plain one. Pure; no I/O.

export interface FlexiLeg { odds: number; probability: number }
export interface FlexiConfig { minRtp: number; multiplier: number; weighted: boolean; oddsKeys: Record<string, number>; maxSelections: number }

/** Live config read 2026-10-02 (GET /api/ng/factsCenter/flexiblebet/v2/getOddsKey). */
export const FLEXI_CONFIG_2026_10: FlexiConfig = {
  minRtp: 0.8, multiplier: 1.0, weighted: true, maxSelections: 50,
  oddsKeys: { 3: 0.95, 4: 0.9, 5: 0.9, 6: 0.85, 7: 0.85, 8: 0.8, 9: 0.8, 10: 0.8, 11: 0.75, 12: 0.75, 13: 0.75, 14: 0.75, 15: 0.65, 16: 0.65, 17: 0.65, 18: 0.6, 19: 0.55, 20: 0.55, 21: 0.55, 22: 0.55, 23: 0.5, 24: 0.45, 25: 0.45, 26: 0.45, 27: 0.45, 28: 0.45, 29: 0.4, 30: 0.4, 31: 0.35, 32: 0.3, 33: 0.25, 34: 0.25, 35: 0.25, 36: 0.25, 37: 0.25, 38: 0.25, 39: 0.2, 40: 0.2, 41: 0.2, 42: 0.2, 43: 0.17, 44: 0.17, 45: 0.17, 46: 0.17, 47: 0.15, 48: 0.15, 49: 0.15, 50: 0.15 },
}

/** P(exactly j of the legs win), j = 0..N (Poisson-binomial; legs independent). */
export function correctDist(probs: number[]): number[] {
  let d = [1]
  for (const q of probs) {
    const nd = new Array(d.length + 1).fill(0)
    for (let j = 0; j < d.length; j++) { nd[j] += d[j] * (1 - q); nd[j + 1] += d[j] * q }
    d = nd
  }
  return d
}
export const atLeast = (dist: number[], k: number) => dist.slice(k).reduce((x, v) => x + v, 0)

/** The legs' odds-weighted return, floored at minRtp (SportyBet's `weightedAvgRTP`). */
export function weightedRtp(legs: FlexiLeg[], cfg: FlexiConfig = FLEXI_CONFIG_2026_10): number {
  const so = legs.reduce((x, l) => x + l.odds, 0)
  const c = so > 0 ? legs.reduce((x, l) => x + l.odds * l.odds * l.probability, 0) / so : 0
  return Math.max(cfg.minRtp, c)
}

/** Flexibet odds for "at least k of these legs" (and the key and F behind them). */
export function flexiOdds(legs: FlexiLeg[], k: number, cfg: FlexiConfig = FLEXI_CONFIG_2026_10): { odds: number; key: number; pAtLeast: number } {
  const N = legs.length
  const F = atLeast(correctDist(legs.map(l => l.probability)), k)
  let key = cfg.oddsKeys[N] ?? 0
  if (cfg.weighted && F > 0) { const L = weightedRtp(legs, cfg); key = Math.min(L, Math.pow(F, cfg.multiplier * (1 - L))) }
  return { odds: F > 0 ? key / F : 0, key, pAtLeast: F }
}

/** One Cut: what the ticket pays if all legs win, and if exactly one leg loses. */
export function oneCut(o: { stake: number; oddsProduct: number; bonusAmount: number; cutOdds: number; maxPayout?: number; sliderPct?: number }): { cutStake: number; allWin: number; oneCutWin: number } {
  const S = o.stake, A = Math.round(o.cutOdds * 1e8) / 1e8, cap = o.maxPayout ?? Infinity
  const d = (o.oddsProduct * S + o.bonusAmount) / S
  const p = o.sliderPct != null ? o.sliderPct * S : Math.max(S / A, S * (A - 1) / (d + A - 2))
  const f = Math.round(A * p * 100) / 100
  const g = Math.floor((d * (S - p) + f) * 100) / 100
  return { cutStake: p, allWin: Math.min(g, cap), oneCutWin: Math.min(f, cap) }
}

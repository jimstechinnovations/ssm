// lib/books/sportybet-bonus.ts
// SportyBet's Multi Bet Bonus, computed EXACTLY as the SportyBet betslip computes it — from the live plan
// the site itself loads (GET /api/ng/promotion/v2/bonus/plans/valid, public). Reproduced from the
// betslip's own code (bonusPlanType 2, "dynamic MBB"); verified against real betslips 2026-09-25:
// 4 qualifying legs → 4.80%, 6 legs → 9.60% (football factor 0.6 × plan max 8% / 16%).
//
//   qualifying legs  = legs with odds ≥ qualifyingOddsLimit (1.20) — legs below simply don't count
//   n                = number of qualifying legs;  [min, max] = the plan's ratio range for n
//   Q                = Π odds of qualifying legs
//   rtp              = Π (odds × p)     over qualifying legs  (p = SportyBet's own outcome probability)
//   target           = round4( Σ odds²·p / Σ odds )
//   pct              = floor₂( target × factor / rtp − 1 ), clamped to [min, max × bonusFactor]
//   bonus            = stake × Q × pct            payout = stake × Π all odds + bonus
//
// bonusFactor comes from the plan's per-sport / per-tournament list (football = 0.6). The slip uses the
// smallest factor among its legs. The plan changes over time (a new one started 2026-09-09) — so it is
// fetched live, never hard-coded.

import 'server-only'
import { cdpFetch } from '../placement/cdp-fetch'

export interface SportyBonusPlan {
  planName: string
  oddsLimit: number                                  // 1.20
  factor: number                                     // dmbbFactor (plan factor / 1e4 → 1)
  ratios: Map<number, { min: number; max: number }>  // qualifying legs → fraction range
  sportFactor: Map<string, number>                   // sportId → bonusFactor (e.g. 'sr:sport:1' → 0.6)
  tournamentFactor: Map<string, number>
  fetchedAt: number
}

export interface BonusLeg { odds: number; probability?: number | null; margin?: number; sportId?: string; tournamentId?: string }

let cache: SportyBonusPlan | null = null
const TTL_MS = 10 * 60_000

/** The live plan (cached 10 min). Throws if SportyBet can't be reached — callers fall back to a table. */
export async function fetchSportyBonusPlan(): Promise<SportyBonusPlan> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache
  // through the debug Chrome when one is up — SportyBet's edge drops our raw server requests at times
  const j = await cdpFetch('https://www.sportybet.com', '/api/ng/promotion/v2/bonus/plans/valid', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' },
  }) as { bizCode?: number; data?: { entityList?: Array<{ planName: string; qualifyingOddsLimit: number; factor: number; bonusRatios: { qualifyingSelections: number; min: number; max: number }[] }>; bonusFactorVOList?: Array<{ sportId?: string; tournamentId?: string; bonusFactor: number; isEnabled?: boolean; isDel?: boolean }> } }
  const plan = j.data?.entityList?.[0]
  if (j.bizCode !== 10000 || !plan) throw new Error(`SportyBet bonus plan unavailable (bizCode ${j.bizCode})`)
  const sportFactor = new Map<string, number>(), tournamentFactor = new Map<string, number>()
  for (const f of j.data?.bonusFactorVOList ?? []) {
    if (f.isEnabled === false || f.isDel) continue
    if (f.tournamentId) tournamentFactor.set(f.tournamentId, f.bonusFactor / 1e4)
    else if (f.sportId) sportFactor.set(f.sportId, f.bonusFactor / 1e4)
  }
  cache = {
    planName: plan.planName, oddsLimit: plan.qualifyingOddsLimit / 1e4, factor: plan.factor / 1e4,
    ratios: new Map(plan.bonusRatios.map(b => [b.qualifyingSelections, { min: b.min / 1e4, max: b.max / 1e4 }])),
    sportFactor, tournamentFactor, fetchedAt: Date.now(),
  }
  return cache
}

/** The bonus SportyBet will add to a winning slip, per ₦1 staked, and its percentage of Q. */
export function sportyBonus(legs: BonusLeg[], plan: SportyBonusPlan): { perStake: number; pct: number; qualifying: number } {
  const q = legs.filter(l => l.odds >= plan.oddsLimit)
  const range = plan.ratios.get(q.length)
  if (!range || q.length === 0) return { perStake: 0, pct: 0, qualifying: q.length }
  const Q = q.reduce((x, l) => x * l.odds, 1)
  // SportyBet's own outcome probability (margin-free). If missing, remove the pair's margin (default 5%):
  // odds × p must be < 1 exactly as on the site, or the formula would wrongly collapse to the minimum.
  const p = (l: BonusLeg) => l.probability != null && l.probability > 0 ? l.probability : 1 / (l.odds * (1 + (l.margin ?? 0.05)))
  const rtp = q.reduce((x, l) => x * l.odds * p(l), 1)
  const target = Math.round(1e4 * q.reduce((s, l) => s + l.odds * l.odds * p(l), 0) / q.reduce((s, l) => s + l.odds, 0)) / 1e4
  const factorOf = (l: BonusLeg) => (l.tournamentId ? plan.tournamentFactor.get(l.tournamentId) : undefined) ?? plan.sportFactor.get(l.sportId ?? 'sr:sport:1') ?? 1
  const bonusFactor = Math.min(...legs.map(factorOf))
  const cap = range.max * bonusFactor < range.min ? range.min : range.max * bonusFactor
  const raw = Math.floor(100 * (target * plan.factor / rtp - 1)) / 100
  const pct = raw < range.min ? range.min : raw > cap ? cap : raw
  return { perStake: Q * pct, pct, qualifying: q.length }
}

/** A leg-count-only approximation for engines that only know "n legs" (all legs ≥ 1.20, cap binding —
 *  which is the case for every realistic accumulator). Used by the older totals engines. */
export function sportyBoostFn(plan: SportyBonusPlan, sportId = 'sr:sport:1'): (n: number) => number {
  const f = plan.sportFactor.get(sportId) ?? 1
  return (n: number) => { const r = plan.ratios.get(n); if (!r) return 0; return Math.max(r.min, r.max * f) }
}

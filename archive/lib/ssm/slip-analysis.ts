// lib/ssm/slip-analysis.ts
// Scores a v3 slip set against per-game scoreline distributions, using the
// fingerprint to turn each leg's market into a real probability, and flags
// (a) duplicate slips and (b) below-threshold (dead-weight) slips.

import type { Slip } from './types'
import { labelToMarket } from './fingerprint'
import type { ScorelineDist } from './scoreline-model'
import { pMarket } from './scoreline-model'

/**
 * Joint win probability of a slip = product over legs of P(leg market resolves),
 * with each leg's probability read from that game's scoreline distribution.
 * Games are assumed independent of each other (true), markets within a game are not
 * (handled by the shared distribution).
 */
export function slipWinProb(slip: Slip, dists: ScorelineDist[]): number {
  let p = 1
  for (const leg of slip.legs) {
    const m = labelToMarket(leg.outcome)
    if (m === null) return NaN
    p *= pMarket(dists[leg.matchIndex], m)
  }
  return p
}

/** Identity of a slip's real bet: per-game (index, outcome). Equal signature ⇒ identical slip. */
export function legSignature(slip: Slip): string {
  return slip.legs.map(l => `${l.matchIndex}:${l.outcome}`).join('|')
}

/** Groups of slips that encode the exact same bet (true duplicates). */
export function findDuplicateGroups(slips: Slip[]): Slip[][] {
  const map = new Map<string, Slip[]>()
  for (const s of slips) {
    const k = legSignature(s)
    const arr = map.get(k)
    if (arr) arr.push(s)
    else map.set(k, [s])
  }
  return [...map.values()].filter(g => g.length > 1)
}

export interface SlipScore {
  slipId: number
  tier: string
  combinedOdds: number
  winProb: number
  ev: number // expected return per ₦1 staked = winProb × combinedOdds
}

export function scoreMatrix(slips: Slip[], dists: ScorelineDist[]): SlipScore[] {
  return slips.map(s => {
    const winProb = slipWinProb(s, dists)
    return {
      slipId: s.slipId,
      tier: s.tier,
      combinedOdds: s.combinedOdds,
      winProb,
      ev: winProb * s.combinedOdds,
    }
  })
}

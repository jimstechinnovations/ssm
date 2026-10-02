// Settle a slip from game results — with EARLY CUT: a slip dies the moment ONE leg is decided against
// it, no need to wait for the other games. All legs decided + correct = won; otherwise still pending.
// Rule-aware: legacy Over/Under legs and Decision Bot legs (1X2, BTTS, clean sheets, …) settle through
// the same scoreline rule that priced them (lib/pedlas/selections.ts).

import { legRuleOf, needsOnlyTotal, ruleWins, type LegRule } from './selections'

/** A finished game's result. home/away are needed for non-total markets (older results carried only total). */
export interface GameResult { finished: boolean; total: number; home?: number; away?: number; live?: boolean; minute?: number }   // live/minute: in play (score so far)
export type Verdict = 'won' | 'lost' | 'pending'
export interface SlipLeg { fixtureId: number; side?: string; line?: number; rule?: LegRule; suspended?: boolean }

// A leg marked `suspended` was DROPPED at placement (the game was suspended/void when we placed) — it is
// NOT part of the actual bet on SportyBet, so it must never settle or cut the slip. This mirrors what
// was really staked (a shorter combo), which is the whole point of place-shorter.
const live = (legs: SlipLeg[]) => legs.filter(l => !l.suspended)

/** Did this leg win? null = not decided yet (game unfinished, or its score isn't detailed enough). */
export function legOutcome(leg: SlipLeg, r: GameResult | null | undefined): boolean | null {
  if (!r || !r.finished) return null
  const rule = legRuleOf(leg)
  if (!rule) return null
  if (r.home != null && r.away != null) return ruleWins(rule, r.home, r.away)
  return needsOnlyTotal(rule) ? ruleWins(rule, r.total, 0) : null
}

/**
 * Verdict for one slip — judged on the legs ACTUALLY placed (suspended/dropped legs excluded). As soon
 * as any FINISHED game contradicts its leg, the slip is LOST (regardless of games still to play). If every
 * real leg is finished and correct → won. Otherwise pending.
 */
export function settleSlip(legs: SlipLeg[], results: Map<number, GameResult | null>, opts: { minCorrect?: number } = {}): Verdict {
  const real = live(legs)
  // FLEXI ticket (floor layer): wins with at least `minCorrect` legs right — lost only once more legs have
  // failed than it forgives, won as soon as `minCorrect` are right (the payout no longer depends on the rest).
  if (opts.minCorrect != null && opts.minCorrect < real.length) {
    let right = 0, wrong = 0
    for (const leg of real) { const w = legOutcome(leg, results.get(leg.fixtureId)); if (w === true) right++; else if (w === false) wrong++ }
    if (right >= opts.minCorrect) return 'won'
    if (wrong > real.length - opts.minCorrect) return 'lost'
    return 'pending'
  }
  let anyPending = false
  for (const leg of real) {
    const won = legOutcome(leg, results.get(leg.fixtureId))
    if (won === null) { anyPending = true; continue }
    if (!won) return 'lost'                               // ← early cut
  }
  return anyPending ? 'pending' : 'won'
}

/** The Flexi threshold stored on a floor ticket's decision (undefined for a normal slip). */
export const flexiMinCorrect = (decision: unknown): number | undefined => {
  const d = decision as { product?: string; k?: number } | null | undefined
  return d?.product === 'flexi' && typeof d.k === 'number' ? d.k : undefined
}

/** The slip's (actually-placed) legs already decided against it (for a "cut by" note). */
export function cutLegs(legs: SlipLeg[], results: Map<number, GameResult | null>): SlipLeg[] {
  return live(legs).filter(leg => legOutcome(leg, results.get(leg.fixtureId)) === false)
}

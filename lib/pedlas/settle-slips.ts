// lib/pedlas/settle-slips.ts
// Settle a slip from game results — with EARLY CUT: a slip dies the moment ONE leg is decided against
// it, no need to wait for the other games. All legs decided + correct = won; otherwise still pending.

export interface GameResult { finished: boolean; total: number }   // total goals (home + away)
export type Verdict = 'won' | 'lost' | 'pending'
export interface SlipLeg { fixtureId: number; side: string; line: number; suspended?: boolean }

// A leg marked `suspended` was DROPPED at placement (the game was suspended/void when we placed) — it is
// NOT part of the actual bet on SportyBet, so it must never settle or cut the slip. This mirrors what
// was really staked (a shorter combo), which is the whole point of place-shorter.
const live = (legs: SlipLeg[]) => legs.filter(l => !l.suspended)

/**
 * Verdict for one slip — judged on the legs ACTUALLY placed (suspended/dropped legs excluded). A leg is
 * Under X.5 → correct iff total < line; Over X.5 → correct iff total > line. As soon as any FINISHED
 * game contradicts its leg, the slip is LOST (regardless of games still to play). If every real leg is
 * finished and correct → won. Otherwise pending.
 */
export function settleSlip(legs: SlipLeg[], results: Map<number, GameResult | null>): Verdict {
  let anyPending = false
  for (const leg of live(legs)) {
    const r = results.get(leg.fixtureId)
    if (!r || !r.finished) { anyPending = true; continue }
    const wentOver = r.total > leg.line                 // e.g. 5 goals > 4.5 → Over
    const legCorrect = leg.side === 'Over' ? wentOver : !wentOver
    if (!legCorrect) return 'lost'                       // ← early cut
  }
  return anyPending ? 'pending' : 'won'
}

/** How many of a slip's (actually-placed) legs are already decided against it (for a "cut by" note). */
export function cutLegs(legs: SlipLeg[], results: Map<number, GameResult | null>): SlipLeg[] {
  return live(legs).filter(leg => {
    const r = results.get(leg.fixtureId)
    if (!r || !r.finished) return false
    const wentOver = r.total > leg.line
    return leg.side === 'Over' ? !wentOver : wentOver
  })
}

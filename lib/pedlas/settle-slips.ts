// lib/pedlas/settle-slips.ts
// Settle a slip from game results — with EARLY CUT: a slip dies the moment ONE leg is decided against
// it, no need to wait for the other games. All legs decided + correct = won; otherwise still pending.

export interface GameResult { finished: boolean; total: number }   // total goals (home + away)
export type Verdict = 'won' | 'lost' | 'pending'
export interface SlipLeg { fixtureId: number; side: string; line: number }

/**
 * Verdict for one slip. A leg is Under X.5 → correct iff total < line; Over X.5 → correct iff total >
 * line. As soon as any FINISHED game contradicts its leg, the slip is LOST (regardless of games still
 * to play). If every leg is finished and correct → won. Otherwise pending.
 */
export function settleSlip(legs: SlipLeg[], results: Map<number, GameResult | null>): Verdict {
  let anyPending = false
  for (const leg of legs) {
    const r = results.get(leg.fixtureId)
    if (!r || !r.finished) { anyPending = true; continue }
    const wentOver = r.total > leg.line                 // e.g. 5 goals > 4.5 → Over
    const legCorrect = leg.side === 'Over' ? wentOver : !wentOver
    if (!legCorrect) return 'lost'                       // ← early cut
  }
  return anyPending ? 'pending' : 'won'
}

/** How many of a slip's legs are already decided against it (for a "cut by" note). */
export function cutLegs(legs: SlipLeg[], results: Map<number, GameResult | null>): SlipLeg[] {
  return legs.filter(leg => {
    const r = results.get(leg.fixtureId)
    if (!r || !r.finished) return false
    const wentOver = r.total > leg.line
    return leg.side === 'Over' ? !wentOver : wentOver
  })
}

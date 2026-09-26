// lib/placement/results.ts
// Grading for the Reports ledger. Uses the SAME score source (lib/pedlas/results) and the SAME
// suspended-aware verdict (lib/pedlas/settle-slips) as session settlement, so a slip can never be
// "won" on one page and "lost" on another.
//
// A leg marked `suspended` was dropped at placement — it is not part of the real bet, so it is shown
// but never counts toward the verdict.

import 'server-only'
import type { PedlasLeg } from '../pedlas/types'
import { fetchResults } from '../pedlas/results'
import { settleSlip, legOutcome } from '../pedlas/settle-slips'

export interface LegResult {
  fixtureId: number
  game: string
  outcome: string      // "Under 4.5"
  totalGoals: number | null
  hit: boolean | null  // null = not finished yet (or dropped at placement)
  suspended?: boolean
}

export interface SlipGrade {
  complete: boolean          // decided (won, or cut early by a missed leg)
  won: boolean | null        // null until decided
  legResults: LegResult[]
  finishedLegs: number
  totalLegs: number          // legs actually placed (dropped legs excluded)
}

type Leg = PedlasLeg & { suspended?: boolean }

/** Grade a placed slip against real scores. Incomplete slips report progress, never a verdict. */
export async function gradeSlip(legs: Leg[], results?: Awaited<ReturnType<typeof fetchResults>>): Promise<SlipGrade> {
  const res = results ?? await fetchResults(legs.map(l => l.fixtureId))
  const legResults: LegResult[] = legs.map(leg => {
    const r = res.get(leg.fixtureId)
    return {
      fixtureId: leg.fixtureId, game: leg.game, outcome: leg.outcome, suspended: leg.suspended || undefined,
      totalGoals: r?.finished ? r.total : null,
      hit: leg.suspended ? null : legOutcome(leg, r),
    }
  })
  const verdict = settleSlip(legs, res)
  const live = legs.filter(l => !l.suspended)
  return {
    complete: verdict !== 'pending',
    won: verdict === 'pending' ? null : verdict === 'won',
    legResults,
    finishedLegs: legResults.filter(r => r.hit !== null).length,
    totalLegs: live.length,
  }
}

// __tests__/lib/pedlas/settle.test.ts
// Grades the real placed book (slip #4, betslip 556632591) against actual results.
// Doubles as the honest record of the 2026-06-26 near-miss.

import { describe, it, expect } from 'vitest'
import type { PedlasLeg, PedlasSlip } from '../../../lib/pedlas/types'
import { legWon, settleSlip, settleBook } from '../../../lib/pedlas/settle'

function leg(fixtureId: number, game: string, league: string, side: 'Over' | 'Under', line: number, odds: number): PedlasLeg {
  return { fixtureId, game, league, kickoff: '2026-06-26T19:45:00Z', line, side, market: `OVER_UNDER_${line}`, outcome: `${side} ${line}`, odds }
}

function slip(slipId: number, legs: PedlasLeg[]): PedlasSlip {
  const combinedOdds = legs.reduce((a, l) => a * l.odds, 1)
  return {
    slipId, vector: legs.map(l => (l.side === 'Over' ? 1 : 0)) as (0 | 1)[], legs,
    legCount: legs.length, combinedOdds, trueProb: 0, boostPct: 20, stake: 100,
    payout: 0, uncappedPayout: 0, capped: false, evMultiple: 0.634, rankScore: 40,
  }
}

// The placed slip #4 (odds ≈ 232.3, Betway return ₦26,013).
const PLACED = slip(4, [
  leg(1, 'Cambrian United vs Newport City FC', 'Club Friendly Games', 'Over', 4.5, 2.75),
  leg(2, 'Harland And Wolff Welders vs The New Saints FC', 'Club Friendly Games', 'Under', 5.5, 1.38),
  leg(3, 'Cork City FC vs Bray Wanderers AFC', 'First Division', 'Under', 4.5, 1.23),
  leg(4, 'Dundalk FC vs Waterford FC', 'Premier Division', 'Over', 4.5, 3.20),
  leg(5, 'Gretna 2008 vs Queens Park FC', 'Club Friendly Games', 'Under', 6.5, 1.20),
  leg(6, 'Senegal vs Iraq', 'FIFA World Cup', 'Over', 4.5, 3.65),
  leg(7, 'Norway vs France', 'FIFA World Cup', 'Over', 4.5, 3.55),
])

// Confirmed final scores (from the betslip). Gretna & Senegal FTs weren't shown, so they
// are left ungraded rather than fabricated (both won per the betslip's 6/7 outcome).
const RESULTS = [
  { fixtureId: 1, homeGoals: 1, awayGoals: 0 }, // Cambrian 1-0 → total 1
  { fixtureId: 2, homeGoals: 1, awayGoals: 2 }, // Harland 1-2 → 3
  { fixtureId: 3, homeGoals: 2, awayGoals: 0 }, // Cork 2-0 → 2
  { fixtureId: 4, homeGoals: 2, awayGoals: 3 }, // Dundalk 2-3 → 5
  { fixtureId: 7, homeGoals: 1, awayGoals: 4 }, // Norway 1-4 → 5
]

describe('PEDLAS settlement — placed slip #4 (betslip 556632591)', () => {
  it('legWon resolves Over/Under X.5 totals correctly', () => {
    expect(legWon(PLACED.legs[0], 1)).toBe(false) // Over 4.5 on total 1 → lost
    expect(legWon(PLACED.legs[3], 5)).toBe(true)  // Over 4.5 on total 5 → won
    expect(legWon(PLACED.legs[1], 3)).toBe(true)  // Under 5.5 on total 3 → won
  })

  it('the only confirmed miss is Cambrian Over 4.5 (1-0) → Bet Saver near-miss', () => {
    const g = settleSlip(PLACED, RESULTS)
    expect(g.graded).toBe(5)
    expect(g.hits).toBe(4)
    expect(g.misses).toBe(1)
    expect(g.betSaverEligible).toBe(true)
    expect(g.missedLegs).toHaveLength(1)
    expect(g.missedLegs[0].game).toMatch(/Cambrian/)
    expect(g.missedLegs[0].side).toBe('Over')
  })

  it('book settlement flags the killer leg and the Over-by-league signal', () => {
    const b = settleBook([PLACED], RESULTS)
    expect(b.slipsBetSaver).toBe(1)
    expect(b.killers[0].game).toMatch(/Cambrian/)
    expect(b.killers[0].lostInSlips).toBe(1)

    const byKey = (lg: string, side: string) => b.byLeagueSide.find(x => x.league === lg && x.side === side)
    // The lesson: Over flips failed on the Club Friendly, won in attacking leagues.
    expect(byKey('Club Friendly Games', 'Over')!.hitRate).toBe(0)   // 0/1
    expect(byKey('Premier Division', 'Over')!.hitRate).toBe(1)      // 1/1
    expect(byKey('FIFA World Cup', 'Over')!.hitRate).toBe(1)        // 1/1
  })
})

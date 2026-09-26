// lib/pedlas/edit.ts
// Pure, client-safe editing of a generated PEDLAS book BEFORE placing: flip a leg's
// side, drop a leg, remove or duplicate a slip — recomputing odds, probability, boost
// tier, payout (cap-aware) and the book-level floor each time. No I/O.
//
// Edits do not change EV honesty: every recomputed slip is still a real −vig multibet.

import type { BinaryAxis, PedlasBook, PedlasLeg, PedlasSlip } from './types'
import { boostedPayout, boostPercent, boostFor, type BoostFn } from './boost'
import { boostForBook } from '../books/boosts'
import { DEFAULT_MAX_PAYOUT } from './budget'

/** Build a leg from an axis + chosen side (used when flipping). */
export function legFromAxis(axis: BinaryAxis, side: 'Over' | 'Under'): PedlasLeg {
  const isOver = side === 'Over'
  return {
    fixtureId: axis.fixtureId,
    game:      axis.game,
    league:    axis.league,
    kickoff:   axis.kickoff,
    line:      axis.line,
    side,
    market:    `OVER_UNDER_${axis.line}`,
    outcome:   `${side} ${axis.line}`,
    odds:      isOver ? axis.overOdds : axis.underOdds,
  }
}

/** Recompute a slip's derived metrics from its current legs (cap-aware). */
export function recomputeSlip(
  slip: PedlasSlip,
  pool: BinaryAxis[],
  stake: number,
  maxPayout: number = DEFAULT_MAX_PAYOUT,
  boost: BoostFn = boostFor,
): PedlasSlip {
  const axById = new Map(pool.map(a => [a.fixtureId, a]))
  const legCount = slip.legs.length
  const combinedOdds = slip.legs.reduce((a, l) => a * l.odds, 1)
  let trueProb = 1
  for (const l of slip.legs) {
    const ax = axById.get(l.fixtureId)
    if (ax) trueProb *= l.side === 'Over' ? ax.overProb : ax.underProb
  }
  const uncappedPayout = boostedPayout(stake, combinedOdds, legCount, boost)
  const payout = Math.min(uncappedPayout, maxPayout)
  return {
    ...slip,
    legCount,
    combinedOdds,
    trueProb,
    boostPct:       boostPercent(legCount, boost),
    stake,
    payout,
    uncappedPayout,
    capped:         uncappedPayout > payout,
    evMultiple:     stake > 0 ? (trueProb * payout) / stake : 0,
    vector:         slip.legs.map(l => {
      const dom = axById.get(l.fixtureId)?.dominantSide ?? 'Under'
      return (l.side === dom ? 0 : 1) as 0 | 1   // state 0 = dominant side
    }),
  }
}

/** Recompute the whole book: all slips + book-level aggregates, re-numbering slip ids. */
export function recomputeBook(book: PedlasBook, maxPayout: number = DEFAULT_MAX_PAYOUT): PedlasBook {
  const stake = book.stakePerSlip
  const pool = book.pool ?? []
  const boost = boostForBook(book.bookId) // legacy saved books (no bookId) = Betway Nigeria
  const slips = book.slips.map((s, i) => ({ ...recomputeSlip(s, pool, stake, maxPayout, boost), slipId: i + 1 }))
  const totalStake = slips.reduce((a, s) => a + s.stake, 0)
  const minPayout = slips.length ? Math.min(...slips.map(s => s.payout)) : 0
  const pAnyHit = slips.reduce((a, s) => a + s.trueProb, 0)
  return {
    ...book,
    slips,
    totalStake,
    minPayout,
    guaranteedFloor: slips.length > 0 && minPayout >= totalStake,
    meta: { ...book.meta, pAnyHit },
  }
}


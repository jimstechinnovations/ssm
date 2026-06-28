// lib/pedlas/edit.ts
// Pure, client-safe editing of a generated PEDLAS book BEFORE placing: flip a leg's
// side, drop a leg, remove or duplicate a slip — recomputing odds, probability, boost
// tier, payout (cap-aware) and the book-level floor each time. No I/O.
//
// Edits do not change EV honesty: every recomputed slip is still a real −vig multibet.

import type { BinaryAxis, PedlasBook, PedlasLeg, PedlasSlip } from './types'
import { boostedPayout, boostPercent } from './boost'
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
): PedlasSlip {
  const axById = new Map(pool.map(a => [a.fixtureId, a]))
  const legCount = slip.legs.length
  const combinedOdds = slip.legs.reduce((a, l) => a * l.odds, 1)
  let trueProb = 1
  for (const l of slip.legs) {
    const ax = axById.get(l.fixtureId)
    if (ax) trueProb *= l.side === 'Over' ? ax.overProb : ax.underProb
  }
  const uncappedPayout = boostedPayout(stake, combinedOdds, legCount)
  const payout = Math.min(uncappedPayout, maxPayout)
  return {
    ...slip,
    legCount,
    combinedOdds,
    trueProb,
    boostPct:       boostPercent(legCount),
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
  const slips = book.slips.map((s, i) => ({ ...recomputeSlip(s, pool, stake, maxPayout), slipId: i + 1 }))
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

const byId = (slips: PedlasSlip[], slipId: number) => slips.findIndex(s => s.slipId === slipId)

/** Flip one leg's side (Under↔Over) using the pool, then recompute. No-op if axis unknown. */
export function flipLeg(book: PedlasBook, slipId: number, fixtureId: number, maxPayout?: number): PedlasBook {
  const axis = (book.pool ?? []).find(a => a.fixtureId === fixtureId)
  if (!axis) return book
  const slips = book.slips.map(s => {
    if (s.slipId !== slipId) return s
    return { ...s, legs: s.legs.map(l => l.fixtureId === fixtureId ? legFromAxis(axis, l.side === 'Over' ? 'Under' : 'Over') : l) }
  })
  return recomputeBook({ ...book, slips }, maxPayout)
}

/** Remove one leg from a slip (shortens it → boost tier drops), then recompute. */
export function removeLeg(book: PedlasBook, slipId: number, fixtureId: number, maxPayout?: number): PedlasBook {
  const slips = book.slips.map(s =>
    s.slipId === slipId ? { ...s, legs: s.legs.filter(l => l.fixtureId !== fixtureId) } : s,
  ).filter(s => s.legs.length > 0)
  return recomputeBook({ ...book, slips }, maxPayout)
}

/** Add an unused axis to a slip (default to its Under/dominant side), then recompute. */
export function addLeg(book: PedlasBook, slipId: number, fixtureId: number, side: 'Over' | 'Under' = 'Under', maxPayout?: number): PedlasBook {
  const axis = (book.pool ?? []).find(a => a.fixtureId === fixtureId)
  if (!axis) return book
  const slips = book.slips.map(s => {
    if (s.slipId !== slipId) return s
    if (s.legs.some(l => l.fixtureId === fixtureId)) return s // no duplicate fixture in a slip
    return { ...s, legs: [...s.legs, legFromAxis(axis, side)] }
  })
  return recomputeBook({ ...book, slips }, maxPayout)
}

/** Remove a whole slip, then recompute (re-numbers remaining slips). */
export function removeSlip(book: PedlasBook, slipId: number, maxPayout?: number): PedlasBook {
  return recomputeBook({ ...book, slips: book.slips.filter(s => s.slipId !== slipId) }, maxPayout)
}

/** Duplicate a slip (so a variant can be edited independently), then recompute. */
export function duplicateSlip(book: PedlasBook, slipId: number, maxPayout?: number): PedlasBook {
  const i = byId(book.slips, slipId)
  if (i < 0) return book
  const copy: PedlasSlip = { ...book.slips[i], legs: book.slips[i].legs.map(l => ({ ...l })) }
  const slips = [...book.slips.slice(0, i + 1), copy, ...book.slips.slice(i + 1)]
  return recomputeBook({ ...book, slips }, maxPayout)
}

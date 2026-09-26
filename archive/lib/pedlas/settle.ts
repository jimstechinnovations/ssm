// lib/pedlas/settle.ts
// PEDLAS Learning Loop — grade a placed book against actual scorelines, find the
// "killer" legs, and accumulate per-(league, side) hit rates. Pure, no I/O.
//
// This is the ONLY honest path to edge: the framework itself is −vig (see pedlas_v1.md
// §5). Tracking which Over/Under flips actually land, by competition, is how you build a
// calibrated p̂ > p_book over time (the spm_v2 edge lever). Grading does not change EV —
// it builds the evidence that, eventually, might.

import type { PedlasLeg, PedlasSlip } from './types'

/** Final score for a fixture (used to grade its legs). */
export interface FixtureResult {
  fixtureId:  number
  homeGoals:  number
  awayGoals:  number
}

/** True iff an Over/Under total-goals leg won, given the match total. Lines are X.5 (no push). */
export function legWon(leg: PedlasLeg, totalGoals: number): boolean {
  return leg.side === 'Over' ? totalGoals > leg.line : totalGoals < leg.line
}

export interface GradedLeg {
  leg:    PedlasLeg
  total:  number | null   // null when no result was supplied
  won:    boolean | null  // null when ungraded
}

export interface GradedSlip {
  slipId:           number
  legs:             GradedLeg[]
  graded:           number   // legs with a known result
  ungraded:         number
  hits:             number
  misses:           number
  won:              boolean   // every graded leg won AND nothing ungraded
  betSaverEligible: boolean   // exactly one miss across graded legs (Betway near-miss insurance)
  missedLegs:       PedlasLeg[]
}

function resultMap(results: FixtureResult[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const r of results) m.set(r.fixtureId, r.homeGoals + r.awayGoals)
  return m
}

/** Grade one slip against the results map. */
export function settleSlip(slip: PedlasSlip, results: FixtureResult[]): GradedSlip {
  const totals = resultMap(results)
  const legs: GradedLeg[] = slip.legs.map(leg => {
    const total = totals.has(leg.fixtureId) ? totals.get(leg.fixtureId)! : null
    return { leg, total, won: total == null ? null : legWon(leg, total) }
  })
  const graded = legs.filter(l => l.won != null)
  const hits = graded.filter(l => l.won === true).length
  const misses = graded.filter(l => l.won === false).length
  const ungraded = legs.length - graded.length
  return {
    slipId:           slip.slipId,
    legs,
    graded:           graded.length,
    ungraded,
    hits,
    misses,
    won:              ungraded === 0 && misses === 0,
    betSaverEligible: misses === 1,
    missedLegs:       graded.filter(l => l.won === false).map(l => l.leg),
  }
}

export interface KillerLeg {
  fixtureId:    number
  game:         string
  league:       string
  outcome:      string
  odds:         number
  lostInSlips:  number   // how many placed slips this leg sank
}

export interface SideHitRate {
  league:   string
  side:     'Over' | 'Under'
  attempts: number
  hits:     number
  hitRate:  number       // hits / attempts
}

export interface BookSettlement {
  slips:           GradedSlip[]
  slipsGraded:     number
  slipsWon:        number
  slipsBetSaver:   number   // missed by exactly one leg
  killers:         KillerLeg[]     // legs that sank the most slips, worst first
  byLeagueSide:    SideHitRate[]   // empirical hit-rate per (league, side) — the knowledge-base seed
}

/** Grade a whole book and surface the killer legs + per-(league,side) hit rates. */
export function settleBook(slips: PedlasSlip[], results: FixtureResult[]): BookSettlement {
  const graded = slips.map(s => settleSlip(s, results))

  // Killer legs: count how many slips each missed leg sank.
  const killerMap = new Map<string, KillerLeg>()
  for (const gs of graded) {
    for (const leg of gs.missedLegs) {
      const key = `${leg.fixtureId}:${leg.outcome}`
      const prev = killerMap.get(key)
      if (prev) prev.lostInSlips++
      else killerMap.set(key, {
        fixtureId: leg.fixtureId, game: leg.game, league: leg.league,
        outcome: leg.outcome, odds: leg.odds, lostInSlips: 1,
      })
    }
  }
  const killers = [...killerMap.values()].sort((a, b) => b.lostInSlips - a.lostInSlips)

  // Per-(league, side) hit rate — count each distinct leg once (not once per slip).
  const seen = new Set<string>()
  const tally = new Map<string, { attempts: number; hits: number; league: string; side: 'Over' | 'Under' }>()
  for (const gs of graded) {
    for (const gl of gs.legs) {
      if (gl.won == null) continue
      const id = `${gl.leg.fixtureId}:${gl.leg.outcome}`
      if (seen.has(id)) continue
      seen.add(id)
      const key = `${gl.leg.league}|${gl.leg.side}`
      const t = tally.get(key) ?? { attempts: 0, hits: 0, league: gl.leg.league, side: gl.leg.side }
      t.attempts++
      if (gl.won) t.hits++
      tally.set(key, t)
    }
  }
  const byLeagueSide: SideHitRate[] = [...tally.values()]
    .map(t => ({ league: t.league, side: t.side, attempts: t.attempts, hits: t.hits, hitRate: t.hits / t.attempts }))
    .sort((a, b) => a.league.localeCompare(b.league) || a.side.localeCompare(b.side))

  return {
    slips:         graded,
    slipsGraded:   graded.filter(g => g.ungraded === 0).length,
    slipsWon:      graded.filter(g => g.won).length,
    slipsBetSaver: graded.filter(g => g.betSaverEligible).length,
    killers,
    byLeagueSide,
  }
}

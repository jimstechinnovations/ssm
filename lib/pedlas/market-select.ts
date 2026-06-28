// lib/pedlas/market-select.ts
// PEDLAS market policy (generalised): for each fixture, across total-goals lines 1.5–6.5, pick the
// most RELIABLE dominant side whose odds still clear 1.20 (so the anchor leg qualifies for Betway
// Win Boost). The dominant side is whichever of Under/Over is more likely — Over 1.5 for high-scoring
// fixtures, Under 4.5 for low-scoring ones. That dominant side is state 0 (the anchor); the breakout
// is state 1. Reliable dominant legs make Coverage's floor strong and slips robust to single upsets.
//
// IMPORTANT: this does NOT create edge (pedlas_v2.md — no model beats the book on any market). It
// only swaps fragile Over-4.5 anchors for reliable ones; the book stays −vig.

import type { Fixture, OddsValue } from '../ssm/types'
import type { BinaryAxis, GoalLine } from './types'

/** Total-goals lines PEDLAS considers, low → high. Low lines anchor on Over, high lines on Under. */
export const PEDLAS_LINES: GoalLine[] = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5]
/** The dominant (anchor) leg must clear this to count toward Win Boost and add meaningful odds. */
export const MIN_DOMINANT_ODDS = 1.20
/** @deprecated kept for back-compat; use MIN_DOMINANT_ODDS. */
export const MIN_UNDER_ODDS = MIN_DOMINANT_ODDS

interface SideOdds { under: number | null; over: number | null }

/** Extract Under/Over odds for a given total-goals line from a fixture's odds list. */
function sidesForLine(odds: OddsValue[], line: GoalLine): SideOdds {
  const market = `OVER_UNDER_${line}`
  let under: number | null = null
  let over: number | null = null
  for (const o of odds) {
    if (o.market !== market) continue
    const label = o.label.toLowerCase()
    if (label.startsWith('under')) under = o.value
    else if (label.startsWith('over')) over = o.value
  }
  return { under, over }
}

/** De-vig a two-way price into true probabilities + overround margin. */
function devig(underOdds: number, overOdds: number) {
  const iU = 1 / underOdds
  const iO = 1 / overOdds
  const sum = iU + iO
  return { underProb: iU / sum, overProb: iO / sum, margin: sum - 1 }
}

export interface MarketSelectOptions {
  lines?: GoalLine[]          // default PEDLAS_LINES
  minDominantOdds?: number    // default 1.20
}

/**
 * Build one BinaryAxis per fixture. For each line with both sides priced, the dominant side is the
 * more probable one; the line qualifies iff the dominant side's odds ≥ minDominantOdds. Among
 * qualifying lines we keep the MOST reliable dominant (lowest dominant odds ≥ threshold). Fixtures
 * with no qualifying line are dropped.
 */
export function selectAxes(fixtures: Fixture[], opts: MarketSelectOptions = {}): BinaryAxis[] {
  const lines = opts.lines ?? PEDLAS_LINES
  const minDominantOdds = opts.minDominantOdds ?? MIN_DOMINANT_ODDS

  const axes: BinaryAxis[] = []

  for (const fx of fixtures) {
    let best: BinaryAxis | null = null
    let bestDomOdds = Infinity

    for (const line of lines) {
      const { under, over } = sidesForLine(fx.odds, line)
      if (under == null || over == null || under <= 1 || over <= 1) continue

      const { underProb, overProb, margin } = devig(under, over)
      const dominantSide: 'Over' | 'Under' = underProb >= overProb ? 'Under' : 'Over'
      const dominantOdds = dominantSide === 'Under' ? under : over
      if (dominantOdds < minDominantOdds) continue // anchor leg must qualify for Win Boost

      // Prefer the most reliable dominant (lowest dominant odds that still clears the gate).
      if (dominantOdds < bestDomOdds) {
        bestDomOdds = dominantOdds
        best = {
          fixtureId: fx.id,
          game:      `${fx.homeTeam} vs ${fx.awayTeam}`,
          league:    fx.league,
          leagueId:  fx.leagueId,
          kickoff:   fx.kickoff,
          line,
          underOdds: under,
          underProb,
          overOdds:  over,
          overProb,
          dominantSide,
          margin,
          volatility: 2 * Math.min(underProb, overProb),
        }
      }
    }

    if (best) axes.push(best)
  }

  return axes
}

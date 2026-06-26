// lib/pedlas/market-select.ts
// PEDLAS market policy: keep ONLY total-goals Under/Over markets whose Under price
// is ≥ 1.20 (so every leg qualifies for Betway Win Boost). For each fixture we pick
// the single most-dominant qualifying line (highest Under probability that still
// clears 1.20) and express it as a binary axis (state 0 = Under, state 1 = Over).

import type { Fixture, OddsValue } from '../ssm/types'
import type { BinaryAxis, GoalLine } from './types'

/** Total-goals lines PEDLAS considers, low → high. */
export const PEDLAS_LINES: GoalLine[] = [4.5, 5.5, 6.5]
export const MIN_UNDER_ODDS = 1.20

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
  const underProb = iU / sum
  const overProb = iO / sum
  return { underProb, overProb, margin: sum - 1 }
}

export interface MarketSelectOptions {
  lines?: GoalLine[]        // default PEDLAS_LINES
  minUnderOdds?: number     // default 1.20
}

/**
 * Build one BinaryAxis per fixture, applying the PEDLAS market policy.
 * A fixture contributes an axis iff at least one requested line has BOTH sides priced
 * AND Under odds ≥ minUnderOdds. Among qualifying lines we choose the most-dominant
 * Under (lowest Under odds that still clears the threshold = highest qualifying line).
 * Fixtures with no qualifying line are dropped.
 */
export function selectAxes(fixtures: Fixture[], opts: MarketSelectOptions = {}): BinaryAxis[] {
  const lines = opts.lines ?? PEDLAS_LINES
  const minUnderOdds = opts.minUnderOdds ?? MIN_UNDER_ODDS

  const axes: BinaryAxis[] = []

  for (const fx of fixtures) {
    let best: BinaryAxis | null = null

    for (const line of lines) {
      const { under, over } = sidesForLine(fx.odds, line)
      if (under == null || over == null) continue
      if (under < minUnderOdds) continue       // Under must qualify for Win Boost
      if (over <= 1) continue                   // sanity

      const { underProb, overProb, margin } = devig(under, over)
      const volatility = 2 * Math.min(underProb, overProb)

      const candidate: BinaryAxis = {
        fixtureId:  fx.id,
        game:       `${fx.homeTeam} vs ${fx.awayTeam}`,
        league:     fx.league,
        leagueId:   fx.leagueId,
        kickoff:    fx.kickoff,
        line,
        underOdds:  under,
        underProb,
        overOdds:   over,
        overProb,
        margin,
        volatility,
      }

      // Prefer the most-dominant qualifying Under (lowest Under odds ≥ threshold).
      if (best === null || candidate.underOdds < best.underOdds) best = candidate
    }

    if (best) axes.push(best)
  }

  return axes
}

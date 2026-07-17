// lib/pedlas/enrich.ts
// Attach an ADVISORY model lean to each axis from team match-history (apifootball H2H/last-N form).
// λ → p̂(dominant) → edge vs the book's de-vigged price → lean. Server-side (network).
//
// ADVISORY ONLY: this never changes odds, probabilities, or EV (backtested no edge — pedlas_v2.md).
// It is shown to the user and fed to NIM as context; the deterministic math is untouched.

import 'server-only'

import type { BinaryAxis } from './types'
import { sideProb } from './types'
import { pHatOver } from './predict'
import { getFixtureForm, formFromMatchResults } from '../football-history/apifootball'
import type { FixtureForm } from '../football-history/apifootball'
import { getTeamRecent, getH2H } from './history-store'

/**
 * HEAD-TO-HEAD enrichment: attach an advisory from the two teams' OWN past meetings (no team-form
 * fallback). pHat = fraction of their meetings that finished Over 4.5 — a direct read of how these
 * specific teams score against each other. Axes with < 2 meetings get no advisory (honest: unknown).
 */
export async function enrichH2H(axes: BinaryAxis[]): Promise<BinaryAxis[]> {
  return Promise.all(axes.map(async (a): Promise<BinaryAxis> => {
    const [home, away] = a.game.split(' vs ')
    if (!home || !away) return a
    const h2h = await getH2H(home.trim(), away.trim(), a.kickoff, 12)
    if (h2h.length < 2) return a
    const overs = h2h.filter(m => m.hg + m.ag >= 5).length
    const overRate = overs / h2h.length
    const lean: 'back' | 'fade' | 'neutral' = overRate >= 0.4 ? 'fade' : overRate <= 0.15 ? 'back' : 'neutral'
    return { ...a, advisory: { pHat: overRate, edge: 1, lean, note: `H2H ${overs}/${h2h.length} over 4.5` } }
  }))
}

const clamp = (x: number, lo = 0.2, hi = 4.5) => Math.max(lo, Math.min(hi, x))

/** Form for a fixture: prefer the local history store (no live calls), fall back to live H2H. */
async function fixtureForm(home: string, away: string, asOf: string): Promise<FixtureForm | null> {
  const [hr, ar] = await Promise.all([getTeamRecent(home, asOf), getTeamRecent(away, asOf)])
  if (hr.length >= 3 && ar.length >= 3) {
    return { home: formFromMatchResults(hr, home), away: formFromMatchResults(ar, away) }
  }
  return getFixtureForm(home, away) // store empty/missing → live apifootball H2H
}

/** Enrich axes with a history-based advisory lean. Axes without form data pass through unchanged. */
export async function enrichAxes(axes: BinaryAxis[]): Promise<BinaryAxis[]> {
  return Promise.all(axes.map(async (a): Promise<BinaryAxis> => {
    const [home, away] = a.game.split(' vs ')
    if (!home || !away) return a
    const form = await fixtureForm(home.trim(), away.trim(), a.kickoff)
    if (!form || form.home.n < 3 || form.away.n < 3) return a

    const lambdaHome = clamp((form.home.attack + form.away.defense) / 2)
    const lambdaAway = clamp((form.away.attack + form.home.defense) / 2)
    const pOver = pHatOver(lambdaHome, lambdaAway, a.line)

    const dom = a.dominantSide ?? 'Under'
    const pHat = dom === 'Over' ? pOver : 1 - pOver
    const pBookDom = sideProb(a, dom)
    const edge = pBookDom > 0 ? pHat / pBookDom : 1
    const lean: 'back' | 'fade' | 'neutral' = edge > 1.05 ? 'back' : edge < 0.95 ? 'fade' : 'neutral'

    return { ...a, advisory: { pHat, edge, lean, note: `form λ ${lambdaHome.toFixed(1)}–${lambdaAway.toFixed(1)}` } }
  }))
}

/** Count of axes carrying an advisory lean (for meta/telemetry). */
export function advisoryCoverage(axes: BinaryAxis[]): { withForm: number; total: number } {
  return { withForm: axes.filter(a => a.advisory).length, total: axes.length }
}

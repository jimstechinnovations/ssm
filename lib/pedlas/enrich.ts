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
import { formFromMatchResults } from '../football-history/apifootball'
import { getTeamRecent, getH2H } from './history-store'

const clamp = (x: number, lo = 0.2, hi = 4.5) => Math.max(lo, Math.min(hi, x))
const clamp01 = (x: number) => Math.max(0.02, Math.min(0.98, x))

/**
 * COMBINED-SIGNAL enrichment (pedlas_v3 §H2H-informed). Every leg is gated on FORM being available
 * for BOTH teams (their own recent scoring, ≥3 games each) — this is the achievable "history-informed"
 * bar, because form is per-team and reusable across fixtures (unlike H2H, which needs the exact pair).
 * When present, we blend three honest signals into P(Under 4.5):
 *
 *     combinedUnder = 0.55·book + 0.30·form + 0.15·H2H     (weights renormalised to what's available)
 *
 *   • book  — the market's de-vigged P(Under). Sharpest single signal (there is no model edge —
 *             see pedlas-no-model-edge; this is selection quality, not +EV).
 *   • form  — Poisson P(total ≤ line) from each team's recency-weighted attack/defence (dense: ~10+
 *             games per team).
 *   • H2H   — fraction of the two teams' OWN prior meetings that finished Under (bonus; ≥1 meeting).
 *
 * advisory.pHat carries the combined P(Over) so the flip-scatter orders variants by real upset risk.
 * Axes WITHOUT form on both teams get no advisory → dropped by the requireHistory gate (never padded).
 * Store-only (getTeamRecent / getH2H) so it never blocks on live network.
 */
export async function enrichSignals(axes: BinaryAxis[]): Promise<BinaryAxis[]> {
  return Promise.all(axes.map(async (a): Promise<BinaryAxis> => {
    const [homeRaw, awayRaw] = a.game.split(' vs ')
    if (!homeRaw || !awayRaw) return a
    const home = homeRaw.trim(), away = awayRaw.trim()

    const [hr, ar, h2h] = await Promise.all([
      getTeamRecent(home, a.kickoff, 14),
      getTeamRecent(away, a.kickoff, 14),
      getH2H(home, away, a.kickoff, 12),
    ])

    // FORM (the gate): both teams need ≥3 recent games or this axis stays un-advised (→ dropped).
    if (hr.length < 3 || ar.length < 3) return a
    const fh = formFromMatchResults(hr, home)
    const fa = formFromMatchResults(ar, away)
    const lambdaHome = clamp((fh.attack + fa.defense) / 2)
    const lambdaAway = clamp((fa.attack + fh.defense) / 2)
    const formUnder = clamp01(1 - pHatOver(lambdaHome, lambdaAway, a.line))

    // BOOK anchor (de-vigged P(Under)).
    const bookUnder = clamp01(sideProb(a, 'Under'))

    // H2H bonus (≥1 meeting): fraction of the pair's own meetings that finished Under the line.
    const underThreshold = Math.floor(a.line)   // line 4.5 → total ≤ 4 is Under
    const h2hCount = h2h.length
    const h2hUnder = h2hCount >= 1 ? clamp01(h2h.filter(m => m.hg + m.ag <= underThreshold).length / h2hCount) : null

    // Weighted blend, renormalised to the signals we actually have.
    const parts: Array<[number, number]> = [[0.55, bookUnder], [0.30, formUnder]]
    if (h2hUnder != null) parts.push([0.15, h2hUnder])
    const wsum = parts.reduce((s, [w]) => s + w, 0)
    const combinedUnder = clamp01(parts.reduce((s, [w, p]) => s + w * p, 0) / wsum)
    const pOver = 1 - combinedUnder

    const lean: 'back' | 'fade' | 'neutral' = pOver >= 0.4 ? 'fade' : pOver <= 0.15 ? 'back' : 'neutral'
    const note = `form λ ${lambdaHome.toFixed(1)}–${lambdaAway.toFixed(1)}` +
      (h2hUnder != null ? ` · H2H ${h2h.filter(m => m.hg + m.ag <= underThreshold).length}/${h2hCount} U` : ' · no H2H')

    return {
      ...a,
      advisory: {
        pHat: pOver, edge: bookUnder > 0 ? combinedUnder / bookUnder : 1, lean, note,
        bookUnder, formUnder, h2hUnder: h2hUnder ?? undefined, h2hCount, combinedUnder, hasForm: true,
      },
    }
  }))
}


/** Count of axes carrying an advisory lean (for meta/telemetry). */
export function advisoryCoverage(axes: BinaryAxis[]): { withForm: number; total: number } {
  return { withForm: axes.filter(a => a.advisory).length, total: axes.length }
}

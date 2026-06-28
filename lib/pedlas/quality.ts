// lib/pedlas/quality.ts
// Pick GOOD legs — confident, cleanly-priced, form-corroborated, decorrelated. This does NOT claim
// +EV or beating the book (it can't, per pedlas_v2.md); it makes the *selection* as defensible as the
// available signals allow, and emits a human rationale per pick for the UI. Pure, no I/O.
//
// Score per axis (higher = better anchor):
//   + book confidence in the dominant side (the leg is genuinely likely)
//   − bookmaker margin (prefer the cleanest-priced, least-vig legs)
//   − axis volatility (prefer lopsided matchups; safer anchors)
//   ± recent-form agreement (history model backs / fades the dominant pick — advisory only)

import type { BinaryAxis, AxisDecision } from './types'
import { sideOdds, sideProb } from './types'

export interface QualityWeights {
  margin?: number      // penalty on vig (default 0.6)
  volatility?: number  // penalty on closeness (default 0.10)
  formAgree?: number   // bonus when form backs the pick (default 0.06)
  formFade?: number    // penalty when form fades the pick (default 0.10)
}

export function scoreAxis(a: BinaryAxis, w: QualityWeights = {}): { quality: number; decision: AxisDecision } {
  const dom = a.dominantSide ?? 'Under'
  const pDom = sideProb(a, dom)
  const oddsDom = sideOdds(a, dom)
  const reasons: string[] = [
    `Book ${(pDom * 100).toFixed(0)}% on ${dom} ${a.line} @ ${oddsDom.toFixed(2)} (margin ${(a.margin * 100).toFixed(1)}%)`,
  ]

  let quality = pDom - (w.margin ?? 0.6) * a.margin - (w.volatility ?? 0.10) * a.volatility

  if (a.advisory) {
    const e = a.advisory.edge
    const modelPct = (a.advisory.pHat * 100).toFixed(0)
    if (e >= 1.05) { quality += (w.formAgree ?? 0.06); reasons.push(`Recent form agrees — ${a.advisory.note} → model ${modelPct}%`) }
    else if (e <= 0.95) { quality -= (w.formFade ?? 0.10); reasons.push(`⚠ Recent form disagrees — ${a.advisory.note} → model ${modelPct}% (less certain)`) }
    else { reasons.push(`Recent form neutral — ${a.advisory.note}`) }
  } else {
    reasons.push('No recent-form data — book price only')
  }

  reasons.push(a.volatility < 0.5 ? 'Lopsided matchup — safer side' : 'Close matchup — less certain')
  const confidence = Math.round(Math.max(0, Math.min(100, quality * 100)))
  // "Most likely" (not "anchor"): this is the fixture's confident side that drove SELECTION.
  // Coverage mostly bets it; Moonshot flips some of these for payout — so the slips' Pick column is
  // the source of truth for what's actually staked.
  reasons.push(`→ Most likely: ${dom} ${a.line} (confidence ${confidence}/100)`)

  return { quality, decision: { pick: `${dom} ${a.line}`, confidence, reasons } }
}

/**
 * Rank fixtures by quality and take the best `targetLegs`, capped at `maxPerLeague` per competition
 * (decorrelation). Each returned axis carries its `decision` (pick + confidence + reasons).
 */
export function selectByQuality(axes: BinaryAxis[], targetLegs: number, maxPerLeague: number, w: QualityWeights = {}): BinaryAxis[] {
  const scored = axes
    .map(a => { const { quality, decision } = scoreAxis(a, w); return { axis: { ...a, decision }, quality } })
    .sort((x, y) => y.quality - x.quality)

  const counts = new Map<number, number>()
  const out: BinaryAxis[] = []
  for (const s of scored) {
    if (out.length >= targetLegs) break
    const c = counts.get(s.axis.leagueId) ?? 0
    if (c >= maxPerLeague) continue
    counts.set(s.axis.leagueId, c + 1)
    out.push(s.axis)
  }
  return out
}

// __tests__/lib/pedlas/coverage.test.ts
// Coverage objective: frequent small win (probability-ranked, neighbours kept, floor guarantee),
// vs Moonshot (payout-ranked, separated). EV stays invariant — only variance is reshaped.

import { describe, it, expect } from 'vitest'
import type { BinaryAxis } from '../../../lib/pedlas/types'
import { buildPedlasBook } from '../../../lib/pedlas/build'

function devigAxis(id: number, league: string, lid: number, kickoff: string, u: number, o: number): BinaryAxis {
  const iU = 1 / u, iO = 1 / o, s = iU + iO
  return { fixtureId: id, game: `G${id}H vs G${id}A`, league, leagueId: lid, kickoff, line: 4.5,
    underOdds: u, underProb: iU / s, overOdds: o, overProb: iO / s, margin: s - 1, volatility: 2 * Math.min(iU / s, iO / s) }
}

function pool(n: number): BinaryAxis[] {
  const base = Date.UTC(2026, 5, 27, 12, 0, 0)
  return Array.from({ length: n }, (_, i) =>
    devigAxis(100 + i, `League ${i % 3}`, i % 3, new Date(base + i * 3_600_000).toISOString(),
      1.26 + (i % 4) * 0.03, 3.4 + (i % 5) * 0.25))
}

const CFG = { budget: 1000, minStake: 100, params: { maxPerLeague: 4 } } as const

describe('PEDLAS coverage objective (the floor)', () => {
  it('ranks deterministically by probability and keeps near-anchor neighbours', async () => {
    const book = await buildPedlasBook({ axes: pool(7), ...CFG, objective: 'coverage' })
    expect(book.objective).toBe('coverage')
    expect(book.meta.ranked).toBe('deterministic')

    // Probability-first → the most-likely placed slip is anchor-near (≥1 breakout via A=1, but few).
    expect(book.slips[0].vector.reduce((a: number, b) => a + b, 0)).toBeGreaterThanOrEqual(1)

    // VARIED: all placed slips are distinct, and breakouts span multiple different legs (not clones).
    const seen = new Set(book.slips.map(s => s.vector.join('')))
    expect(seen.size).toBe(book.slips.length)
    const variedLegs = new Set<number>()
    book.slips.forEach(s => s.vector.forEach((b, i) => { if (b) variedLegs.add(i) }))
    expect(variedLegs.size).toBeGreaterThanOrEqual(2)
  })

  it('guarantees the floor: every placed slip pays back at least the total stake', async () => {
    const book = await buildPedlasBook({ axes: pool(7), ...CFG, objective: 'coverage' })
    expect(book.guaranteedFloor).toBe(true)
    expect(book.minPayout).toBeGreaterThanOrEqual(book.totalStake)
    expect(book.totalStake).toBe(book.slips.length * 100)
  })

  it('lifts P(any hit) far above the moonshot for the same pool/budget', async () => {
    const axes = pool(7)
    const moon = await buildPedlasBook({ axes, ...CFG, objective: 'moonshot', rank: 'deterministic' })
    const cover = await buildPedlasBook({ axes, ...CFG, objective: 'coverage' })
    expect(cover.meta.pAnyHit).toBeGreaterThan(moon.meta.pAnyHit)
    expect(cover.meta.pAnyHit).toBeGreaterThan(0.05) // scattered coverage still beats the moonshot
  })

  it('EV is invariant: coverage does not beat the margin (still −vig, ≈ moonshot)', async () => {
    const axes = pool(7)
    const moon = await buildPedlasBook({ axes, ...CFG, objective: 'moonshot', rank: 'deterministic' })
    const cover = await buildPedlasBook({ axes, ...CFG, objective: 'coverage' })
    expect(cover.verdict.evMultiple).toBeLessThan(1)
    expect(moon.verdict.evMultiple).toBeLessThan(1)
    expect(cover.verdict.positiveEV).toBe(false)
    // Same underlying −vig: per-slip EV multiples agree within a couple of percent.
    expect(Math.abs(cover.verdict.evMultiple - moon.verdict.evMultiple)).toBeLessThan(0.05)
  })

  it('confidence-pinned scatter: confident legs are pinned, uncertain legs vary across slips', async () => {
    // legs 0–4 high confidence (pinned), legs 5–9 low confidence (scattered)
    const axes = pool(10).map((a, i) => ({ ...a, decision: { pick: 'x', confidence: i < 5 ? 80 : 40, reasons: [] } }))
    const book = await buildPedlasBook({ axes, budget: 1000, minStake: 100, objective: 'coverage', rank: 'deterministic', params: { maxPerLeague: 9, pinTopFrac: 0.5 } })
    expect(book.slips.length).toBeGreaterThan(1)
    // pinned legs (0–4) are the dominant side (bit 0) in EVERY slip
    for (const s of book.slips) expect(s.vector.slice(0, 5).every(b => b === 0)).toBe(true)
    // variation/breakouts happen only among the uncertain legs (5–9)
    const variedPositions = new Set<number>()
    for (const s of book.slips) s.vector.forEach((b, i) => { if (b === 1) variedPositions.add(i) })
    expect([...variedPositions].every(i => i >= 5)).toBe(true)
    expect(variedPositions.size).toBeGreaterThan(1) // genuinely scattered across uncertain legs
  })

  it('moonshot remains the default (back-compat)', async () => {
    const book = await buildPedlasBook({ axes: pool(7), ...CFG, rank: 'deterministic' })
    expect(book.objective).toBe('moonshot')
  })
})

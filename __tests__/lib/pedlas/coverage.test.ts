// __tests__/lib/pedlas/coverage.test.ts
// Coverage objective: frequent small win (probability-ranked, neighbours kept, floor guarantee),
// vs Moonshot (payout-ranked, separated). EV stays invariant — only variance is reshaped.

import { describe, it, expect } from 'vitest'
import type { BinaryAxis } from '../../../lib/pedlas/types'
import { buildPedlasBook } from '../../../lib/pedlas/build'
import { hammingDistance } from '../../../lib/pedlas/separation'

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

    // Probability-first → the first placed slip is the most likely (fewest Over-flips, A≥1 ⇒ ≥1).
    expect(book.slips[0].vector.reduce((a: number, b) => a + b, 0)).toBe(1)

    // Neighbours kept: at least one pair of placed slips differs by a single leg (Hamming 1) —
    // exactly the near-miss catcher that Moonshot's separation removes.
    let minPair = Infinity
    for (let i = 0; i < book.slips.length; i++)
      for (let j = i + 1; j < book.slips.length; j++)
        minPair = Math.min(minPair, hammingDistance(book.slips[i].vector, book.slips[j].vector))
    expect(minPair).toBe(1)
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
    expect(cover.meta.pAnyHit).toBeGreaterThan(0.2) // realistic floor for a 7-leg pool
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

  it('moonshot remains the default (back-compat)', async () => {
    const book = await buildPedlasBook({ axes: pool(7), ...CFG, rank: 'deterministic' })
    expect(book.objective).toBe('moonshot')
  })
})

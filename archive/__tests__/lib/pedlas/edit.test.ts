// __tests__/lib/pedlas/edit.test.ts
// Pure edit ops recompute odds/probability/boost/payout/floor correctly.

import { describe, it, expect } from 'vitest'
import type { BinaryAxis } from '../../../lib/pedlas/types'
import { buildPedlasBook } from '../../../lib/pedlas/build'
import { boostPercent, boostedPayout } from '../../../lib/pedlas/boost'
import { flipLeg, removeLeg, removeSlip, duplicateSlip, addLeg } from '../../../lib/pedlas/edit'

function devigAxis(id: number, kickoff: string, u: number, o: number): BinaryAxis {
  const iU = 1 / u, iO = 1 / o, s = iU + iO
  return { fixtureId: id, game: `G${id}H vs G${id}A`, league: `League ${id % 3}`, leagueId: id % 3, kickoff,
    line: 4.5, underOdds: u, underProb: iU / s, overOdds: o, overProb: iO / s, margin: s - 1, volatility: 2 * Math.min(iU / s, iO / s) }
}
const pool = (n: number) => Array.from({ length: n }, (_, i) =>
  devigAxis(100 + i, new Date(Date.UTC(2026, 5, 27, 12) + i * 3.6e6).toISOString(), 1.26 + (i % 4) * 0.03, 3.4 + (i % 5) * 0.25))

const build = () => buildPedlasBook({ axes: pool(7), budget: 1000, minStake: 100, objective: 'moonshot', rank: 'deterministic', params: { maxPerLeague: 4 } })

describe('PEDLAS edit ops', () => {
  it('book now carries the pool (both sides) for editing', async () => {
    const b = await build()
    expect(b.pool).toHaveLength(7)
    expect(b.pool[0].underOdds).toBeGreaterThan(1)
    expect(b.pool[0].overOdds).toBeGreaterThan(1)
  })

  it('flipLeg flips the side and recomputes odds/prob', async () => {
    const b = await build()
    const slip = b.slips[0]
    const leg = slip.legs[0]
    const axis = b.pool.find(a => a.fixtureId === leg.fixtureId)!
    const flipped = flipLeg(b, slip.slipId, leg.fixtureId)
    const newLeg = flipped.slips.find(s => s.slipId === slip.slipId)!.legs.find(l => l.fixtureId === leg.fixtureId)!
    expect(newLeg.side).toBe(leg.side === 'Over' ? 'Under' : 'Over')
    expect(newLeg.odds).toBe(newLeg.side === 'Over' ? axis.overOdds : axis.underOdds)
    // combinedOdds = product of leg odds; payout cap-aware
    const s2 = flipped.slips.find(s => s.slipId === slip.slipId)!
    expect(s2.combinedOdds).toBeCloseTo(s2.legs.reduce((a, l) => a * l.odds, 1), 9)
    expect(s2.payout).toBeCloseTo(Math.min(boostedPayout(100, s2.combinedOdds, s2.legCount), 50_000_000), 4)
  })

  it('removeLeg shortens the slip and drops the boost tier', async () => {
    const b = await build()
    const slip = b.slips[0]
    const fid = slip.legs[0].fixtureId
    const after = removeLeg(b, slip.slipId, fid)
    const s2 = after.slips.find(s => s.slipId === slip.slipId)!
    expect(s2.legCount).toBe(slip.legCount - 1)
    expect(s2.legs.some(l => l.fixtureId === fid)).toBe(false)
    expect(s2.boostPct).toBe(boostPercent(slip.legCount - 1))
    expect(s2.combinedOdds).toBeCloseTo(s2.legs.reduce((a, l) => a * l.odds, 1), 9)
  })

  it('removeSlip drops a slip and renumbers; duplicateSlip adds an independent copy', async () => {
    const b = await build()
    const n = b.slips.length
    const removed = removeSlip(b, b.slips[0].slipId)
    expect(removed.slips).toHaveLength(n - 1)
    expect(removed.slips.map(s => s.slipId)).toEqual(Array.from({ length: n - 1 }, (_, i) => i + 1))

    const dup = duplicateSlip(b, b.slips[1].slipId)
    expect(dup.slips).toHaveLength(n + 1)
    // editing the duplicate must not mutate the original
    const before = b.slips[1].legs[0].side
    flipLeg(dup, 3, dup.slips[2].legs[0].fixtureId)
    expect(b.slips[1].legs[0].side).toBe(before)
  })

  it('addLeg adds an unused fixture and refuses duplicates within a slip', async () => {
    const b = await build()
    // shrink slip 1 to make room, then add a fixture back
    const fid = b.slips[0].legs[0].fixtureId
    const trimmed = removeLeg(b, b.slips[0].slipId, fid)
    const added = addLeg(trimmed, 1, fid, 'Under')
    const s = added.slips.find(x => x.slipId === 1)!
    expect(s.legs.some(l => l.fixtureId === fid && l.side === 'Under')).toBe(true)
    // adding the same fixture again is a no-op
    const again = addLeg(added, 1, fid, 'Over')
    expect(again.slips.find(x => x.slipId === 1)!.legs.filter(l => l.fixtureId === fid)).toHaveLength(1)
  })

  it('book-level floor recomputes after edits', async () => {
    const b = await build()
    // flipping an Over→Under lowers that slip's odds/payout; floor recomputes from minPayout
    let edited = b
    for (const l of b.slips[0].legs) if (l.side === 'Over') { edited = flipLeg(edited, 1, l.fixtureId); break }
    const s = edited.slips.find(x => x.slipId === 1)!
    expect(edited.minPayout).toBeLessThanOrEqual(s.payout + 1e-6)
    expect(edited.guaranteedFloor).toBe(edited.minPayout >= edited.totalStake)
  })
})

// lib/pedlas/floor.ts
// The FLOOR layer (docs/near-miss-design.md): SportyBet Flexibet tickets on LIKELY, low-margin legs, so a
// day with no jackpot still returns part of the budget. Each ticket is 8 legs at the tightest "at least k of
// 8" that still lands ≥ 45% of the time — where SportyBet's Flexi key sits at the legs' own return (≈ 0.95
// per ₦1; a plain 8-leg slip keeps ≈ 0.82). Measured: on our real finished games, 400 such tickets returned
// 89% of their stake; simulated, a 25% floor turns a typical losing day from ₦0 back into ~24% back.
//
// Legs come from games the jackpot slips do NOT use when possible, so the floor doesn't fail on the same
// results. Prices are SportyBet's exact Flexi formula (lib/books/sportybet-flexi.ts) on its own outcome
// probabilities — the number the betslip will show. Pure.

import type { SelectionGame, Selection } from './selections'
import { flexiOdds } from '../books/sportybet-flexi'

export interface FloorOptions {
  budget: number
  stake: number
  legs?: number            // per ticket (default 8)
  minLegOdds?: number      // Flexi minimum per leg is 1.01; ≥ 1.20 keeps the legs meaningful (default 1.2)
  minLegP?: number         // only likely legs (default 0.55)
  minWinChance?: number    // tightest k whose P(≥ k) stays above this (default 0.45)
  avoidFixtures?: Set<number>   // games the jackpot slips use — avoided while others are left
  /** Probability of a pick: SportyBet's own by default; pass the reference-panel consensus to use it. */
  probOf?: (g: SelectionGame, s: Selection) => number | undefined
}
export interface FloorLeg { game: SelectionGame; sel: Selection; p: number }
export interface FloorTicket { legs: FloorLeg[]; k: number; n: number; odds: number; key: number; pWin: number; payout: number; why: string }

export function buildFloor(games: SelectionGame[], o: FloorOptions): { tickets: FloorTicket[]; notes: string[] } {
  const N = o.legs ?? 8, minOdds = o.minLegOdds ?? 1.2, minP = o.minLegP ?? 0.55, minWin = o.minWinChance ?? 0.45
  const count = Math.floor(o.budget / o.stake)
  const notes: string[] = []
  if (count < 1) return { tickets: [], notes }
  const pOf = (g: SelectionGame, s: Selection) => o.probOf?.(g, s) ?? s.probability
  // the best floor pick per game: likely, and the lowest margin (highest odds × P) among likely picks
  const candidates = games.map(g => {
    const picks = g.selections.map(s => ({ s, p: pOf(g, s) })).filter((x): x is { s: Selection; p: number } => x.p != null && x.p >= minP && x.p < 0.97 && x.s.odds >= minOdds)
    const best = picks.sort((a, b) => b.s.odds * b.p - a.s.odds * a.p)[0]
    return best ? { game: g, sel: best.s, p: best.p } : null
  }).filter((x): x is FloorLeg => !!x)
  const fresh = candidates.filter(c => !o.avoidFixtures?.has(c.game.fixtureId))
  const pool = (fresh.length >= N ? fresh : candidates).sort((a, b) => b.sel.odds * b.p - a.sel.odds * a.p)
  if (fresh.length < N && candidates.length >= N) notes.push(`floor: only ${fresh.length} games outside the jackpot slips — sharing some games with them`)
  if (pool.length < N) { notes.push(`floor: only ${pool.length} games have a likely pick (P ≥ ${minP}, odds ≥ ${minOdds}) — need ${N}`); return { tickets: [], notes } }

  // spread games evenly over tickets: each ticket takes the N least-used games (ties → better margin)
  const used = new Map<number, number>()
  const seen = new Set<string>()
  const tickets: FloorTicket[] = []
  for (let t = 0; t < count * 3 && tickets.length < count; t++) {
    const legs = [...pool].sort((a, b) => (used.get(a.game.fixtureId) ?? 0) - (used.get(b.game.fixtureId) ?? 0) || ((t * 7919 + a.game.fixtureId) % 97) - ((t * 7919 + b.game.fixtureId) % 97)).slice(0, N)
    const key = legs.map(l => l.game.fixtureId).sort().join(',')
    for (const l of legs) used.set(l.game.fixtureId, (used.get(l.game.fixtureId) ?? 0) + 1)
    if (seen.has(key)) continue
    seen.add(key)
    const fl = legs.map(l => ({ odds: l.sel.odds, probability: l.sel.probability ?? l.p }))
    let k = N; while (k > 1 && flexiOdds(fl, k).pAtLeast < minWin) k--
    const f = flexiOdds(fl, k)
    const payout = Math.floor(o.stake * f.odds * 100) / 100
    if (payout <= o.stake) continue   // a ticket that can't even return its stake is pointless
    tickets.push({
      legs, k, n: N, odds: f.odds, key: f.key, pWin: f.pAtLeast, payout,
      why: `floor ticket: Flexi "at least ${k} of ${N}" on likely, low-margin picks — lands ${(100 * f.pAtLeast).toFixed(0)}% of the time, pays ₦${payout.toFixed(2)} on ₦${o.stake}, returns ₦${f.key.toFixed(3)} per ₦1 on average (a plain 8-leg slip ≈ ₦0.82)`,
    })
  }
  if (tickets.length < count) notes.push(`floor: built ${tickets.length} of ${count} tickets (not enough distinct game sets)`)
  return { tickets, notes }
}

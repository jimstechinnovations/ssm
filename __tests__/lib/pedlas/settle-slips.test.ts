import { describe, it, expect } from 'vitest'
import { settleSlip, cutLegs, type GameResult } from '@/lib/pedlas/settle-slips'

const legs = [
  { fixtureId: 1, side: 'Under', line: 4.5 },
  { fixtureId: 2, side: 'Under', line: 4.5 },
  { fixtureId: 3, side: 'Over', line: 4.5 },
]
const R = (m: Record<number, GameResult | null>) => new Map<number, GameResult | null>(Object.entries(m).map(([k, v]) => [Number(k), v]))

describe('settle: early cut', () => {
  it('one finished Under game that went Over → LOST immediately, even with games still pending', () => {
    const r = R({ 1: { finished: true, total: 6 } })   // game 1 went Over → the Under leg is dead
    expect(settleSlip(legs, r)).toBe('lost')
    expect(cutLegs(legs, r).map(l => l.fixtureId)).toEqual([1])
  })

  it('an Over leg whose game finished Under → LOST', () => {
    expect(settleSlip(legs, R({ 3: { finished: true, total: 2 } }))).toBe('lost')
  })

  it('all finished + all correct → WON', () => {
    const r = R({ 1: { finished: true, total: 2 }, 2: { finished: true, total: 1 }, 3: { finished: true, total: 5 } })
    expect(settleSlip(legs, r)).toBe('won')
  })

  it('some finished-correct, some pending, none wrong → still PENDING', () => {
    const r = R({ 1: { finished: true, total: 2 }, 2: null, 3: { finished: false, total: 0 } })
    expect(settleSlip(legs, r)).toBe('pending')
  })

  it('nothing finished → pending', () => {
    expect(settleSlip(legs, R({}))).toBe('pending')
  })
})

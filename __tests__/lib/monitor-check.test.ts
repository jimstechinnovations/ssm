import { describe, it, expect } from 'vitest'
import { checkDraft, factsText, type MonitorFacts } from '@/lib/monitor/check'

const facts: MonitorFacts = {
  at: '2026-10-03T14:00:00Z',
  jackpot: { total: 22, aliveNow: 5, aliveAtFullTime: 10, chancePct: 1.47, aliveChange: -3, chanceChangePct: -1.1 },
  newlyCut: [{ game: 'Albacete Balompie vs Eibar', score: '1-3', slipsCut: 1 }],
  newlyBeatenInPlay: [{ game: 'The New Saints FC vs Cambrian United', score: '5-0', pick: 'Under 4.5' }],
  live: [], nextUp: [],
  floor: { total: 75, won: 0, lost: 0, open: 75, returnedNaira: 0, stakedNaira: 750 },
  placement: { placed: 97, stakedNaira: 2950, openOnSportyBet: null, mismatches: [], checkNote: null },
  winners: [], firstCheck: false, soFar: { cutGames: 7, slipsCut: 12, beatenInPlay: 5 },
}

describe('live monitor fact check', () => {
  it('accepts an update that only uses numbers from the facts', () => {
    expect(checkDraft('Three jackpot slips were cut, leaving 5 alive with a 1.47% win chance. Albacete lost 1-3 to Eibar.', facts)).toEqual([])
  })
  it('rejects an invented number, a wrong currency, and a missing alive count', () => {
    expect(checkDraft('5 slips alive, 2.9% chance.', facts)).toContain('number "2.9" is not in the facts')
    expect(checkDraft('5 alive; floor returned £0.', facts)).toContain('uses a currency other than ₦')
    expect(checkDraft('Slips are still alive at 1.47%.', facts)).toContain("doesn't state the 5 slips alive")
  })
  it('accepts the alive count written as a word', () => {
    expect(checkDraft('The jackpot chance is 1.47% with five slips still alive.', facts)).toEqual([])
  })
  it('rejects a model that answers with its working-out', () => {
    const leak = 'We need to produce a live update. Rules: 1-3 short sentences, under 60 words. aliveNow 5, chancePct 1.47 ...'
    expect(checkDraft(leak, facts).some(i => /not in the facts/.test(i))).toBe(true)
  })
  it('the plain update is short and states only what changed', () => {
    const t = factsText(facts)
    expect(t).toContain('5 of 22 jackpot slips alive (1.47% chance)')
    expect(t).toContain('Albacete Balompie vs Eibar 1-3')
    expect(checkDraft(t, facts)).toEqual([])                        // the fallback always passes its own check
    expect(factsText({ ...facts, firstCheck: true, newlyCut: [], newlyBeatenInPlay: [] })).toContain('12 slips cut so far in 7 games')
  })
})

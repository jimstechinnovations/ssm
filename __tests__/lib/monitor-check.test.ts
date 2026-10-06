import { describe, it, expect } from 'vitest'
import { checkDraft, factsText, leaderOf, type MonitorFacts } from '@/lib/monitor/check'

const facts: MonitorFacts = {
  at: '2026-10-03T14:00:00Z',
  jackpot: { total: 22, aliveNow: 5, aliveAtFullTime: 10, chancePct: 1.47, aliveChange: -3, chanceChangePct: -1.1 },
  newlyCut: [{ game: 'Albacete Balompie vs Eibar', score: '1-3', slipsCut: 1 }],
  newlyBeatenInPlay: [{ game: 'The New Saints FC vs Cambrian United', score: '5-0', pick: 'Under 4.5' }],
  live: [], nextUp: [],
  floor: { total: 75, won: 0, lost: 0, open: 75, returnedNaira: 0, stakedNaira: 750 },
  placement: { placed: 97, stakedNaira: 2950, openOnSportyBet: null, mismatches: [], checkNote: null },
  winners: [], cashedOut: { slips: 0, returnedNaira: 0, newly: [] }, firstCheck: false, soFar: { cutGames: 7, slipsCut: 12, beatenInPlay: 5 },
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
  it('checks counts written as words against the facts (2026-10-04: "five slips cut across four matches" when 12 were cut in 11)', () => {
    const many: MonitorFacts = { ...facts, jackpot: { ...facts.jackpot, aliveNow: 9, total: 22, aliveChange: -13, chancePct: 6.66 },
      newlyCut: Array.from({ length: 11 }, (_, i) => ({ game: `G${i} vs H${i}`, score: '1-0', slipsCut: i === 0 ? 2 : 1, wasBeatenInPlay: false })),
      soFar: { cutGames: 11, slipsCut: 12, beatenInPlay: 1 } }
    const bad = checkDraft('Five slips were cut across four finished matches, leaving 9 jackpot slips alive at a 6.66% chance.', many)
    expect(bad.some(i => /five slips were cut/.test(i))).toBe(true)
    expect(bad.some(i => /four games/.test(i))).toBe(true)
    expect(checkDraft('Twelve slips were cut across 11 games, leaving nine jackpot slips alive at a 6.66% chance.', many)).toEqual([])
  })
  it('rejects a score that is not a score in the facts (2026-10-04: "Kolos Kovalivka 2–1" when it was 0-1)', () => {
    const live: MonitorFacts = { ...facts, live: [{ game: 'FC Kolos Kovalivka 2 vs FC Oleksandriya', score: '0-1', minute: 61, slipsRiding: 1 }, { game: 'Valencia CF Mestalla vs SCR Pena Deportiva', score: '3-2', minute: 83, slipsRiding: 1 }] }
    expect(checkDraft('5 slips alive at 1.47%. Live: FC Kolos Kovalivka 2–1 FC Oleksandriya, 61st minute.', live).some(i => /score "2–1"/.test(i))).toBe(true)
    expect(checkDraft('5 slips alive at 1.47%. Live: Kolos Kovalivka 2 trail Oleksandriya 0‑1 (61′); Valencia Mestalla lead 3–2.', live)).toEqual([])
    expect(checkDraft('5 slips alive at 1.47%. Next: Azerbaijan vs Lithuania at 13:00.', { ...live, nextUp: [{ game: 'Azerbaijan vs Lithuania', kickoffUtc: '13:00', slipsRiding: 1 }] })).toEqual([])
  })
  it('rejects a sentence that names the wrong team as leading (2026-10-04: "Athletic Bilbao B lead 1-3")', () => {
    const g = 'Athletic Bilbao B vs CD Extremadura'
    const live: MonitorFacts = { ...facts, live: [{ game: g, score: '1-3', minute: 81, slipsRiding: 2, leading: leaderOf(g, '1-3') }] }
    expect(leaderOf(g, '1-3')).toBe('CD Extremadura')
    expect(checkDraft('5 slips alive at 1.47%. Athletic Bilbao B lead 1-3 at 81.', live).some(i => /Bilbao B is ahead/.test(i))).toBe(true)
    expect(checkDraft('5 slips alive at 1.47%. Athletic Bilbao B trail 1-3 at 81; Extremadura lead.', live)).toEqual([])
    // the word belongs to the team named closest before it (a correct draft was rejected on 2026-10-06)
    const two: MonitorFacts = { ...facts, live: [
      { game: 'Algeria vs Niger', score: '0-1', minute: 22, slipsRiding: 4, leading: 'Niger' },
      { game: 'Cyprus vs San Marino', score: '1-0', minute: 22, slipsRiding: 3, leading: 'Cyprus' }] }
    expect(checkDraft('5 slips alive at 1.47%. Algeria vs Niger 0-1 (Niger leading), Cyprus vs San Marino 1-0 (Cyprus leading).', two)).toEqual([])
    expect(checkDraft('5 slips alive at 1.47%. Algeria vs Niger 0-1 (Algeria leading).', two).some(i => /Algeria is ahead/.test(i))).toBe(true)
  })
  it('an update must mention floor tickets that just settled', () => {
    const fl: MonitorFacts = { ...facts, floor: { ...facts.floor, won: 5, open: 70, returnedNaira: 81, newlyWon: 5, newlyLost: 0 } }
    expect(checkDraft('No jackpot slips were cut; 5 slips remain alive at 1.47%.', fl)).toContain("doesn't mention the floor tickets that just settled")
    expect(checkDraft('5 floor tickets won (₦81 back so far); 5 jackpot slips alive at 1.47%.', fl)).toEqual([])
    expect(checkDraft('No new cuts or losses; 5 jackpot slips alive at 1.47%. 5 floor tickets won, ₦81 back.', fl)).toContain('says nothing changed while floor tickets just settled')
    const t = factsText(fl)
    expect(t).toContain('Floor tickets: 5 more won')
    expect(checkDraft(t, fl)).toEqual([])
  })
  it('rejects a reply cut off mid-sentence', () => {
    expect(checkDraft('The jackpot chance fell to 1.47% with 5 slips alive. Albacete Balompie vs Eibar is', facts)).toContain('ends mid-sentence (the reply was cut off)')
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

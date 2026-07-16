// __tests__/lib/books/sportybet.test.ts
// Pure parser tests for the SportyBet feed mapper (shape captured from the live API probe
// on 2026-07-13 — see lib/books/sportybet.ts).

import { describe, it, expect } from 'vitest'
import { parseSportybetPage, sportybetEventToFixture } from '../../../lib/books/sportybet'

const event = (over: string, under: string, specifier = 'total=4.5') => ({
  eventId: 'sr:match:53452533',
  estimateStartTime: 1784055600000,
  homeTeamName: 'France',
  awayTeamName: 'Spain',
  sport: { category: { name: 'International', tournament: { id: 'sr:tournament:16', name: 'World Cup' } } },
  markets: [{
    id: '18',
    specifier,
    outcomes: [
      { id: '12', odds: over, isActive: 1, desc: `Over ${specifier.slice(6)}` },
      { id: '13', odds: under, isActive: 1, desc: `Under ${specifier.slice(6)}` },
    ],
  }],
})
const tournament = { id: 'sr:tournament:16', name: 'World Cup' }

describe('sportybet feed mapper', () => {
  it('maps a live-shaped event onto the engine Fixture', () => {
    const fx = sportybetEventToFixture(event('3.60', '1.27'), tournament)
    expect(fx).not.toBeNull()
    expect(fx!.id).toBe(53452533)                      // digits of sr:match:53452533
    expect(fx!.leagueId).toBe(16)                      // digits of sr:tournament:16
    expect(fx!.homeTeam).toBe('France')
    expect(fx!.kickoff).toBe(new Date(1784055600000).toISOString())
    expect(fx!.league).toBe('International — World Cup')
    expect(fx!.odds).toEqual([
      { bookmaker: 'sportybet', market: 'OVER_UNDER_4.5', label: 'Over 4.5', value: 3.6 },
      { bookmaker: 'sportybet', market: 'OVER_UNDER_4.5', label: 'Under 4.5', value: 1.27 },
    ])
  })

  it('drops whole lines (voidable), inactive outcomes, and odds ≤ 1', () => {
    const whole = sportybetEventToFixture(event('1.08', '8.75', 'total=4'), tournament)
    expect(whole).toBeNull() // total=4 is a whole line → no usable odds → dropped

    const ev = event('3.60', '1.27')
    ev.markets[0].outcomes[0].isActive = 0
    ev.markets[0].outcomes[1].odds = '1.00'
    expect(sportybetEventToFixture(ev, tournament)).toBeNull()
  })

  it('parses a full page across tournaments and skips malformed events', () => {
    const page = {
      bizCode: 10000,
      data: {
        totalNum: 3,
        tournaments: [
          { ...tournament, events: [event('3.60', '1.27')] },
          { id: 'sr:tournament:17', name: 'Serie A', events: [{ eventId: 'bad-id' }] }, // malformed
        ],
      },
    }
    const fixtures = parseSportybetPage(page)
    expect(fixtures).toHaveLength(1)
    expect(fixtures[0].id).toBe(53452533)
  })
})

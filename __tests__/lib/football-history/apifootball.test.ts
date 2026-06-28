// __tests__/lib/football-history/apifootball.test.ts
// Pure form math (recency-weighted attack/defence + side detection). Network calls not tested here.

import { describe, it, expect } from 'vitest'
import { formFrom } from '../../../lib/football-history/apifootball'

describe('formFrom', () => {
  it('computes attack/defence with home/away side detection', () => {
    const results = [
      { match_date: '2026-05-01', match_hometeam_name: 'Alpha FC', match_awayteam_name: 'X', match_hometeam_score: '3', match_awayteam_score: '1' },
      { match_date: '2026-05-08', match_hometeam_name: 'Y', match_awayteam_name: 'Alpha FC', match_hometeam_score: '0', match_awayteam_score: '2' },
    ]
    const f = formFrom(results, 'Alpha FC')
    expect(f.n).toBe(2)
    expect(f.attack).toBeGreaterThan(1.5)   // scored 3 (home) and 2 (away)
    expect(f.defense).toBeLessThan(1.5)      // conceded 1 and 0
  })

  it('weights recent matches more', () => {
    // Old: prolific; recent: goalless. Recency weighting should pull attack down.
    const old = Array.from({ length: 6 }, (_, i) => ({ match_date: `2026-01-0${i + 1}`, match_hometeam_name: 'A', match_awayteam_name: 'o', match_hometeam_score: '4', match_awayteam_score: '0' }))
    const recent = Array.from({ length: 6 }, (_, i) => ({ match_date: `2026-06-0${i + 1}`, match_hometeam_name: 'A', match_awayteam_name: 'o', match_hometeam_score: '0', match_awayteam_score: '0' }))
    const f = formFrom([...old, ...recent], 'A')
    expect(f.attack).toBeLessThan(2) // recent goalless dominates
  })

  it('defaults gracefully with no usable data', () => {
    expect(formFrom([], 'Z').n).toBe(0)
    expect(formFrom([{ match_hometeam_name: 'A', match_awayteam_name: 'B' }], 'A').n).toBe(0) // no scores
  })
})

// lib/placement/results.ts
// Auto-settlement: fetch REAL final scores for the fixtures we bet on, then grade the slip.
//
// We key results by the SAME id we placed with (SportyBet fixtures are Sportradar match ids,
// so `sr:match:<fixtureId>` round-trips exactly — no fuzzy team-name matching, no drift).
//   GET /api/ng/factsCenter/event?eventId=sr:match:<id>
//     → { status, matchStatus, setScore: "2:1" }  (status 3/4 = ended; "AP"/"Ended"/"FT")
//
// Grading uses the engine's own legWon() so the bet's truth and the model's truth agree.

import 'server-only'
import type { PedlasLeg } from '../pedlas/types'
import { legWon } from '../pedlas/settle'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export interface FixtureScore {
  fixtureId: number
  finished: boolean
  homeGoals?: number
  awayGoals?: number
  totalGoals?: number
  matchStatus?: string
}

/** Final score for one fixture, by the id we stored on the leg. */
export async function fetchFixtureScore(fixtureId: number): Promise<FixtureScore> {
  const url = `https://www.sportybet.com/api/ng/factsCenter/event?eventId=${encodeURIComponent(`sr:match:${fixtureId}`)}`
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, cache: 'no-store' })
  if (!res.ok) return { fixtureId, finished: false }
  const json = (await res.json()) as {
    bizCode?: number
    data?: { status?: number; matchStatus?: string; setScore?: string }
  }
  const d = json.data
  if (json.bizCode !== 10000 || !d) return { fixtureId, finished: false }

  // setScore "2:1" is only meaningful once the match has actually ended.
  const ended = /^(ended|ft|aet|ap|closed)$/i.test(d.matchStatus ?? '') || d.status === 3 || d.status === 4
  const m = /^(\d+):(\d+)$/.exec((d.setScore ?? '').trim())
  if (!ended || !m) return { fixtureId, finished: false, matchStatus: d.matchStatus }

  const homeGoals = Number(m[1])
  const awayGoals = Number(m[2])
  return {
    fixtureId, finished: true, homeGoals, awayGoals,
    totalGoals: homeGoals + awayGoals,
    matchStatus: d.matchStatus,
  }
}

export interface LegResult {
  fixtureId: number
  game: string
  outcome: string      // "Under 4.5"
  totalGoals: number | null
  hit: boolean | null  // null = not finished yet
}

export interface SlipGrade {
  complete: boolean          // every leg has a final score
  won: boolean | null        // null until complete
  legResults: LegResult[]
  finishedLegs: number
  totalLegs: number
}

/** Grade a placed slip against real scores. Incomplete slips report progress, never a verdict. */
export async function gradeSlip(legs: PedlasLeg[]): Promise<SlipGrade> {
  const scores = await Promise.all(legs.map(l => fetchFixtureScore(l.fixtureId)))
  const legResults: LegResult[] = legs.map((leg, i) => {
    const s = scores[i]
    return {
      fixtureId: leg.fixtureId,
      game: leg.game,
      outcome: leg.outcome,
      totalGoals: s.finished ? s.totalGoals! : null,
      hit: s.finished ? legWon(leg, s.totalGoals!) : null,
    }
  })
  const finishedLegs = legResults.filter(r => r.hit !== null).length
  const complete = finishedLegs === legs.length

  // A slip is dead the moment ANY finished leg misses — no need to wait for the rest.
  const anyMiss = legResults.some(r => r.hit === false)
  const won = anyMiss ? false : (complete ? legResults.every(r => r.hit === true) : null)

  return { complete: complete || anyMiss, won, legResults, finishedLegs, totalLegs: legs.length }
}

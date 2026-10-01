// lib/books/sportybet.ts
// SportyBet Nigeria adapter — public JSON API, no auth (probed working 2026-07-13).
//
// Endpoint: GET https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents
//   ?sportId=sr:sport:1&marketId=18&pageSize=100&pageNum=N
// Returns tournaments → events → markets(id "18" = Over/Under, specifier "total=X") with
// outcomes [{desc: "Over X" | "Under X", odds}]. We keep only half-lines (X.5) that map onto
// the engine's OVER_UNDER_<line> markets.
//
// Win Boost: SportyBet NG Multi Bet Bonus. The EXACT bonus is computed at build time from SportyBet's LIVE
// plan (lib/books/sportybet-bonus.ts — the site's own formula, verified to the kobo on real betslips
// 2026-09-25). This table is only the FALLBACK when the plan can't be fetched: a snapshot of plan
// MBB_1788955181864 (from 2026-09-09) for football — plan max × football factor 0.6, which is the rate the
// site applies to every realistic accumulator. Legs under 1.20 don't count toward it (they don't cancel it).
// (The July table this replaced came from an older plan and overstated long slips ~2×.)

import 'server-only'
import type { BookAdapter } from './types'
import type { Fixture, OddsValue, MarketType } from '../pedlas/types'
import { boostFromTable } from '../pedlas/boost'
import { selectionsFromMarkets, SELECTION_MARKET_IDS, type SelectionGame } from '../pedlas/selections'
import { cdpFetch } from '../placement/cdp-fetch'

// fallback: effective bonus fraction by number of QUALIFYING legs (plan MBB_1788955181864, football)
const SPORTYBET_MBB: { legs: number; fraction: number }[] = [
  { legs: 2, fraction: 0.018 }, { legs: 3, fraction: 0.03 }, { legs: 4, fraction: 0.048 }, { legs: 5, fraction: 0.072 },
  { legs: 6, fraction: 0.096 }, { legs: 7, fraction: 0.12 }, { legs: 8, fraction: 0.15 }, { legs: 9, fraction: 0.18 },
  { legs: 10, fraction: 0.198 }, { legs: 11, fraction: 0.21 }, { legs: 12, fraction: 0.222 }, { legs: 13, fraction: 0.24 },
  { legs: 14, fraction: 0.252 }, { legs: 15, fraction: 0.27 }, { legs: 16, fraction: 0.3 }, { legs: 17, fraction: 0.33 },
  { legs: 18, fraction: 0.36 }, { legs: 19, fraction: 0.39 }, { legs: 20, fraction: 0.42 }, { legs: 21, fraction: 0.45 },
  { legs: 22, fraction: 0.48 }, { legs: 23, fraction: 0.51 }, { legs: 24, fraction: 0.54 }, { legs: 25, fraction: 0.57 },
  { legs: 26, fraction: 0.6 }, { legs: 27, fraction: 0.66 }, { legs: 28, fraction: 0.72 }, { legs: 29, fraction: 0.78 },
  { legs: 30, fraction: 0.96 }, { legs: 31, fraction: 1.08 }, { legs: 32, fraction: 1.14 }, { legs: 33, fraction: 1.2 },
  { legs: 34, fraction: 1.26 }, { legs: 35, fraction: 1.32 }, { legs: 36, fraction: 1.38 }, { legs: 37, fraction: 1.44 },
  { legs: 38, fraction: 1.5 }, { legs: 39, fraction: 1.56 }, { legs: 40, fraction: 1.62 },
]
const sportyBoost = boostFromTable(SPORTYBET_MBB)

const ORIGIN = 'https://www.sportybet.com'
const BASE_PATH = '/api/ng/factsCenter/pcUpcomingEvents'
const BASE = ORIGIN + BASE_PATH
const PAGE_SIZE = 100
const MAX_PAGES = 10

/** A leg shape sufficient to build a SportyBet selection (fixtureId + line + side). */
export interface BookingLeg { fixtureId: number; line: number; side: 'Under' | 'Over' }

/** Engine total-goals lines we accept from the feed. */
const ACCEPTED_LINES = new Set([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5])

// ── Feed shapes (only the fields we read) ────────────────────────────────────────
interface SbOutcome { id?: string; desc?: string; odds?: string; probability?: string; isActive?: number }
interface SbMarket { id?: string; specifier?: string; status?: number; outcomes?: SbOutcome[] }
interface SbEvent {
  eventId?: string           // "sr:match:53452533"
  estimateStartTime?: number // epoch ms
  homeTeamName?: string
  awayTeamName?: string
  markets?: SbMarket[]
  sport?: { category?: { name?: string; tournament?: { id?: string; name?: string } } }
}
interface SbTournament { id?: string; name?: string; events?: SbEvent[] }
interface SbResponse { bizCode?: number; data?: { totalNum?: number; tournaments?: SbTournament[] } }

/** Trailing digits of an "sr:*:123" id, or null. */
function srIdDigits(id: string | undefined): number | null {
  const m = /:(\d+)$/.exec(id ?? '')
  return m ? Number(m[1]) : null
}

/** Map one SportyBet event to the engine's Fixture, or null if unusable. */
export function sportybetEventToFixture(ev: SbEvent, tournament: SbTournament): Fixture | null {
  const id = srIdDigits(ev.eventId)
  if (id == null || !ev.homeTeamName || !ev.awayTeamName || !ev.estimateStartTime) return null

  const odds: OddsValue[] = []
  for (const m of ev.markets ?? []) {
    if (m.id !== '18') continue
    if (m.status !== undefined && m.status !== 0) continue // suspended/deactivated market — never select
    const lm = /^total=(\d+(?:\.\d+)?)$/.exec(m.specifier ?? '')
    if (!lm) continue
    const line = Number(lm[1])
    if (!ACCEPTED_LINES.has(line)) continue // whole lines can void — engine is half-line binary only
    const market = `OVER_UNDER_${line}` as MarketType
    for (const o of m.outcomes ?? []) {
      if (o.isActive === 0) continue
      const v = Number(o.odds)
      const desc = o.desc ?? ''
      if (!Number.isFinite(v) || v <= 1) continue
      if (/^over\b/i.test(desc)) odds.push({ bookmaker: 'sportybet', market, label: `Over ${line}`, value: v })
      else if (/^under\b/i.test(desc)) odds.push({ bookmaker: 'sportybet', market, label: `Under ${line}`, value: v })
    }
  }
  if (odds.length === 0) return null

  const t = tournament.name ?? ev.sport?.category?.tournament?.name ?? 'Unknown'
  const cat = ev.sport?.category?.name
  return {
    id,
    homeTeam: ev.homeTeamName,
    awayTeam: ev.awayTeamName,
    league: cat ? `${cat} — ${t}` : t,
    leagueId: srIdDigits(tournament.id ?? ev.sport?.category?.tournament?.id) ?? 0,
    kickoff: new Date(ev.estimateStartTime).toISOString(),
    odds,
  }
}

/** Parse a full pcUpcomingEvents response page into Fixtures (pure — unit-tested). */
export function parseSportybetPage(json: SbResponse): Fixture[] {
  const out: Fixture[] = []
  for (const t of json.data?.tournaments ?? []) {
    for (const ev of t.events ?? []) {
      const fx = sportybetEventToFixture(ev, t)
      if (fx) out.push(fx)
    }
  }
  return out
}

export const sportybet: BookAdapter = {
  id: 'sportybet',
  label: 'SportyBet Nigeria',
  currency: 'NGN',
  minStake: 10, // verified against a real placed slip (₦10, 2026-07-13)
  maxPayout: 200_000_000, // SportyBet NGN max-win cap (₦200M; Betway's is ₦50M — don't confuse them)
  boostFor: sportyBoost, // SportyBet MBB, captured from live betslips 2026-07-19 (see SPORTYBET_MBB)
  boostVerified: true,
  feedVerified: true,
  credentialEnv: { username: 'SPORTY_NUMBER', password: 'SPORTY_PASSWORD' },

  /** Decision Bot feed: every upcoming game with all two-sided selections (1X2↔DC, totals, team totals,
   *  BTTS, odd/even, clean sheets), each carrying the market/specifier/outcome ids booking codes need. */
  async fetchSelectionGames(opts) {
    const fromMs = Date.parse(`${opts.dateFrom}T00:00:00Z`)
    const toMs = Date.parse(`${opts.dateTo}T23:59:59Z`)
    const minKick = Date.now() + opts.minKickoffGapMinutes * 60_000
    const games: SelectionGame[] = []
    const seen = new Set<number>()
    for (let page = 1; page <= MAX_PAGES && games.length < opts.scanLimit; page++) {
      const path = `${BASE_PATH}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=${encodeURIComponent(SELECTION_MARKET_IDS.join(','))}&pageSize=${PAGE_SIZE}&pageNum=${page}`
      // CDP first (a real browser), raw fetch as fallback — see cdp-fetch.ts. The feed also rejects a raw
      // fetch without a full browser user-agent (HTTP 403) even when the TCP block isn't in play.
      const json = await cdpFetch<SbResponse>(ORIGIN, path, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
      if (json.bizCode !== 10000) throw new Error(`SportyBet feed bizCode ${json.bizCode ?? 'unknown'}`)
      const tournaments = json.data?.tournaments ?? []
      for (const t of tournaments) for (const ev of t.events ?? []) {
        const id = srIdDigits(ev.eventId)
        if (id == null || seen.has(id) || !ev.homeTeamName || !ev.awayTeamName || !ev.estimateStartTime) continue
        const kick = ev.estimateStartTime
        if (kick < fromMs || kick > toMs || kick < minKick) continue
        const selections = selectionsFromMarkets(ev.markets ?? [])
        if (selections.length < 6) continue
        const cat = ev.sport?.category?.name, tn = t.name ?? ev.sport?.category?.tournament?.name ?? 'Unknown'
        seen.add(id)
        games.push({ fixtureId: id, home: ev.homeTeamName, away: ev.awayTeamName, game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, league: cat ? `${cat} — ${tn}` : tn, tournamentId: t.id ?? ev.sport?.category?.tournament?.id, kickoff: new Date(kick).toISOString(), selections })
      }
      if (tournaments.length === 0 || page * PAGE_SIZE >= (json.data?.totalNum ?? 0)) break
    }
    return { games, source: 'sportybet-public-api (all two-sided markets)' }
  },

  async fetchFixtures(opts) {
    const fromMs = Date.parse(`${opts.dateFrom}T00:00:00Z`)
    const toMs = Date.parse(`${opts.dateTo}T23:59:59Z`)
    const minKick = Date.now() + opts.minKickoffGapMinutes * 60_000

    const fixtures: Fixture[] = []
    const seen = new Set<number>()
    let feedUrl = ''
    for (let page = 1; page <= MAX_PAGES && fixtures.length < opts.scanLimit; page++) {
      const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=18&pageSize=${PAGE_SIZE}&pageNum=${page}`
      if (!feedUrl) feedUrl = url
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' },
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`SportyBet feed HTTP ${res.status} (page ${page})`)
      const json = (await res.json()) as SbResponse
      if (json.bizCode !== 10000) throw new Error(`SportyBet feed bizCode ${json.bizCode ?? 'unknown'}`)

      const pageFixtures = parseSportybetPage(json)
      if (pageFixtures.length === 0) break
      for (const fx of pageFixtures) {
        const kick = Date.parse(fx.kickoff)
        if (Number.isNaN(kick) || kick < fromMs || kick > toMs || kick < minKick) continue
        if (seen.has(fx.id)) continue
        seen.add(fx.id)
        fixtures.push(fx)
        if (fixtures.length >= opts.scanLimit) break
      }
      const total = json.data?.totalNum ?? 0
      if (page * PAGE_SIZE >= total) break
    }

    fixtures.sort((a, b) => a.kickoff.localeCompare(b.kickoff))
    return { fixtures, source: 'sportybet-public-api', feedUrl }
  },
}

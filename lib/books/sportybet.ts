// lib/books/sportybet.ts
// SportyBet Nigeria adapter — public JSON API, no auth (probed working 2026-07-13).
//
// Endpoint: GET https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents
//   ?sportId=sr:sport:1&marketId=18&pageSize=100&pageNum=N
// Returns tournaments → events → markets(id "18" = Over/Under, specifier "total=X") with
// outcomes [{desc: "Over X" | "Under X", odds}]. We keep only half-lines (X.5) that map onto
// the engine's OVER_UNDER_<line> markets.
//
// Win Boost: SportyBet NG has a multiple-bet bonus, but its table is NOT yet verified against
// a live betslip — so this adapter uses ZERO boost (never overstate payouts, pedla_v1.md §3).

import 'server-only'
import type { BookAdapter } from './types'
import type { Fixture, OddsValue, MarketType } from '../pedlas/types'
import { noBoost } from '../pedlas/boost'

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const PAGE_SIZE = 100
const MAX_PAGES = 10

/** A leg shape sufficient to build a SportyBet selection (fixtureId + line + side). */
export interface BookingLeg { fixtureId: number; line: number; side: 'Under' | 'Over' }

/**
 * Create a SportyBet booking code for a set of total-goals legs (public /orders/share API, no auth).
 * The code reproduces the exact slip in any SportyBet session — this is how a human places a
 * bot-built PEDLA slip with one tap (Playwright can't place real bets; see the placement notes).
 */
export async function sportybetBookingCode(legs: BookingLeg[]): Promise<{ code: string; url: string }> {
  const selections = legs.map(l => ({
    eventId: `sr:match:${l.fixtureId}`,
    marketId: '18',
    specifier: `total=${l.line}`,
    outcomeId: l.side === 'Under' ? '13' : '12',
  }))
  const res = await fetch('https://www.sportybet.com/api/ng/orders/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', platform: 'web' },
    body: JSON.stringify({ selections, shareType: 1 }),
  })
  const json = (await res.json()) as { bizCode?: number; data?: { shareCode?: string; shareURL?: string } }
  if (json.bizCode !== 10000 || !json.data?.shareCode) {
    throw new Error(`SportyBet booking code failed (bizCode ${json.bizCode})`)
  }
  return {
    code: json.data.shareCode,
    url: json.data.shareURL ?? `https://www.sportybet.com/ng/?shareCode=${json.data.shareCode}`,
  }
}

/** Engine total-goals lines we accept from the feed. */
const ACCEPTED_LINES = new Set([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5])

// ── Feed shapes (only the fields we read) ────────────────────────────────────────
interface SbOutcome { desc?: string; odds?: string; isActive?: number }
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
  maxPayout: 50_000_000, // published NGN max-win cap; verify against a live capped slip
  boostFor: noBoost,     // real bonus table unverified — zero, never overstate
  boostVerified: false,
  feedVerified: true,
  credentialEnv: { username: 'SPORTY_NUMBER', password: 'SPORTY_PASSWORD' },

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

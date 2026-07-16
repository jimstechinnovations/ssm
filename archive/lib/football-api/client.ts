import 'server-only'

import { createServerClient } from '../supabase/server'
import { FOOTBALL_API_KEY, FOOTBALL_URL } from '../env'
import type { Fixture, OddsValue, MarketType } from '../ssm/types'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a full API-Football URL from a path and query-string record. */
function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const base = FOOTBALL_URL.startsWith('http') ? FOOTBALL_URL : `https://${FOOTBALL_URL}`
  const url = new URL(path, base)
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      url.searchParams.set(key, String(val))
    }
  }
  return url.toString()
}

/** Shared headers sent on every request to API-Football. */
function apiHeaders(): HeadersInit {
  return {
    'x-rapidapi-key': FOOTBALL_API_KEY,
    'x-rapidapi-host': 'v3.football.api-sports.io',
  }
}

// ---------------------------------------------------------------------------
// Market mapping helpers
// ---------------------------------------------------------------------------

/**
 * Derives the internal MarketType from a bet id + value label combination.
 * Returns null for unknown/unsupported bet ids.
 *
 * Extended in v2 to handle:
 *  - bet.id 4 (BTTS): normalises "Yes" → "BTTS Yes", "No" → "BTTS No"
 *  - bet.id 5 (Over/Under): handles 0.5 line in addition to 1.5/2.5/3.5
 *  - bet.id 7 (Double Chance): maps "Home/Away"→"DC 12", "Home/Draw"→"DC 1X", "Draw/Away"→"DC X2"
 *  - bet.id 57 (Parity): maps "Odd"→"Odd", "Even"→"Even"
 */
function resolveMarket(betId: number, valueLabel: string): MarketType | null {
  switch (betId) {
    case 1:
      return '1X2'
    case 4:
      // API returns "Yes"/"No" — keep as-is for BTTS market type
      return 'BTTS'
    case 5: {
      // e.g. "Over 2.5" → 'OVER_UNDER_2.5', "Under 0.5" → 'OVER_UNDER_0.5'
      const match = valueLabel.match(/[\d.]+/)
      if (!match) return null
      const threshold = match[0]
      return `OVER_UNDER_${threshold}` as MarketType
    }
    case 7:
      // Double Chance — map to canonical labels used by gate screener
      // "Home/Away" (1 or 2 wins) → DC 12
      // "Home/Draw" (1 or X)      → DC 1X  (not used in gates but kept for completeness)
      // "Draw/Away" (X or 2)      → DC X2  (unused)
      return null   // handled below as passthrough — label is preserved as-is for gate screener
    case 8:
      return 'ASIAN_HANDICAP'
    default:
      return null
  }
}

/**
 * Normalises an odds value label for gate-screener consumption.
 * Returns the canonical label string and a synthetic market type when needed,
 * or null to skip this value entirely.
 *
 * Called as a fallback for bet IDs not fully handled by resolveMarket.
 */
function resolveV2OddsEntry(
  betId: number,
  valueLabel: string,
  bookmakerName: string,
  oddStr: string,
): OddsValue | null {
  const value = parseFloat(oddStr)
  if (isNaN(value)) return null

  // bet.id 4 — BTTS: normalise "Yes"→"BTTS Yes", "No"→"BTTS No"
  if (betId === 4) {
    const label = valueLabel === 'Yes' ? 'BTTS Yes' : valueLabel === 'No' ? 'BTTS No' : valueLabel
    return { bookmaker: bookmakerName, market: 'BTTS', label, value }
  }

  // bet.id 5 — Over/Under (all thresholds including 0.5)
  if (betId === 5) {
    const match = valueLabel.match(/[\d.]+/)
    if (!match) return null
    const market = `OVER_UNDER_${match[0]}` as MarketType
    return { bookmaker: bookmakerName, market, label: valueLabel, value }
  }

  // bet.id 7 — Double Chance
  if (betId === 7) {
    // "Home/Away" → "DC 12", "Home/Draw" → "DC 1X", "Draw/Away" → "DC X2"
    let label: string
    if (valueLabel === 'Home/Away')  label = 'DC 12'
    else if (valueLabel === 'Home/Draw') label = 'DC 1X'
    else if (valueLabel === 'Draw/Away') label = 'DC X2'
    else label = valueLabel
    return { bookmaker: bookmakerName, market: '1X2', label, value }
  }

  // bet.id 57 — Parity (Odd/Even goals)
  if (betId === 57) {
    if (valueLabel !== 'Odd' && valueLabel !== 'Even') return null
    return { bookmaker: bookmakerName, market: '1X2', label: valueLabel, value }
  }

  return null
}

// ---------------------------------------------------------------------------
// Raw API response shapes (internal only – not exported)
// ---------------------------------------------------------------------------

interface RawFixtureItem {
  fixture: {
    id: number
    date: string
    venue?: { name?: string }
  }
  teams: {
    home: { name: string }
    away: { name: string }
  }
  league: {
    id: number
    name: string
  }
}

interface RawBetValue {
  value: string
  odd: string
}

interface RawBet {
  id: number
  name: string
  values: RawBetValue[]
}

interface RawBookmaker {
  id: number
  name: string
  bets: RawBet[]
}

interface RawOddsItem {
  fixture: { id: number }
  bookmakers: RawBookmaker[]
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SearchParams {
  search?: string
  date?: string    // YYYY-MM-DD
  league?: number
  next?: number    // default 10
}

// ---------------------------------------------------------------------------
// searchFixtures
// ---------------------------------------------------------------------------

/**
 * Searches upcoming fixtures via API-Football v3.
 * Returns a mapped Fixture[] on success, or [] on any error.
 */
export async function searchFixtures(params: SearchParams = {}): Promise<Fixture[]> {
  try {
    const url = buildUrl('/fixtures', {
      next: params.next ?? 10,
      ...(params.search ? { search: params.search } : {}),
      ...(params.date   ? { date: params.date }     : {}),
      ...(params.league ? { league: params.league } : {}),
    })

    const res = await fetch(url, {
      headers: apiHeaders(),
      // Opt out of Next.js extended fetch caching – fixture lists should
      // always reflect the current state.
      cache: 'no-store',
    })

    if (!res.ok) {
      return []
    }

    const json = await res.json() as { response?: RawFixtureItem[] }

    if (!Array.isArray(json.response)) {
      return []
    }

    return json.response.map((item): Fixture => ({
      id:       item.fixture.id,
      homeTeam: item.teams.home.name,
      awayTeam: item.teams.away.name,
      league:   item.league.name,
      leagueId: item.league.id,
      kickoff:  item.fixture.date,
      venue:    item.fixture.venue?.name,
      odds:     [],
    }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// searchFixturesByDateRange  (v2 — bulk gate screening)
// ---------------------------------------------------------------------------

/**
 * Fetches all fixtures across a date range for bulk gate screening.
 * Enumerates each day in [dateFrom, dateTo] and merges results.
 *
 * @param dateFrom     YYYY-MM-DD (inclusive)
 * @param dateTo       YYYY-MM-DD (inclusive, max dateFrom + 7 days)
 * @param bookmakerId  API-Football bookmaker ID, or null for no filter
 */
export async function searchFixturesByDateRange(
  dateFrom: string,
  dateTo: string,
  bookmakerId: number | null,
): Promise<Fixture[]> {
  const from = new Date(dateFrom)
  const to   = new Date(dateTo)

  const allFixtures: Fixture[] = []
  const seenIds = new Set<number>()

  const current = new Date(from)
  while (current <= to) {
    const dateStr = current.toISOString().slice(0, 10) // YYYY-MM-DD

    try {
      const params: Record<string, string | number | undefined> = {
        date: dateStr,
        ...(bookmakerId !== null ? { bookmaker: bookmakerId } : {}),
      }
      const url = buildUrl('/fixtures', params)
      const res = await fetch(url, { headers: apiHeaders(), cache: 'no-store' })

      if (res.ok) {
        const json = await res.json() as { response?: RawFixtureItem[] }
        if (Array.isArray(json.response)) {
          for (const item of json.response) {
            if (!seenIds.has(item.fixture.id)) {
              seenIds.add(item.fixture.id)
              allFixtures.push({
                id:       item.fixture.id,
                homeTeam: item.teams.home.name,
                awayTeam: item.teams.away.name,
                league:   item.league.name,
                leagueId: item.league.id,
                kickoff:  item.fixture.date,
                venue:    item.fixture.venue?.name,
                odds:     [],
              })
            }
          }
        }
      }
    } catch {
      // Partial failure — skip this day, continue
    }

    current.setDate(current.getDate() + 1)
  }

  // Sort by kickoff ascending
  allFixtures.sort((a, b) => a.kickoff.localeCompare(b.kickoff))
  return allFixtures
}

// ---------------------------------------------------------------------------
// fetchFixtureOdds  (updated v2 signature — optional bookmakerId)
// ---------------------------------------------------------------------------

/**
 * Fetches odds for a given fixture id, using the Supabase odds_cache as a
 * short-circuit. Cache TTL is 4 hours.
 *
 * Returns { odds, oddsUnavailable } where oddsUnavailable=true signals that
 * the API call failed and the caller should surface an OddsUnavailableError.
 *
 * @param fixtureId    API-Football fixture id
 * @param bookmakerId  Optional bookmaker id override (default: 8 = Bet365)
 */
export async function fetchFixtureOdds(
  fixtureId: number,
  bookmakerId?: number | null,
): Promise<{ odds: OddsValue[]; oddsUnavailable: boolean }> {
  try {
    const supabase = createServerClient()

    // ------------------------------------------------------------------
    // 1. Cache check
    // ------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cacheQuery = supabase
      .from('odds_cache')
      .select('odds_data')
      .eq('fixture_id', fixtureId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    // The Supabase client lacks generated types for odds_cache, so we cast
    // through unknown to avoid TS2339 "Property does not exist on never".
    const { data: cached, error: cacheErr } = await (cacheQuery as unknown as Promise<{
      data: { odds_data: unknown } | null
      error: unknown
    }>)

    if (!cacheErr && cached) {
      return { odds: cached.odds_data as OddsValue[], oddsUnavailable: false }
    }

    // ------------------------------------------------------------------
    // 2. Cache miss – call API-Football
    // ------------------------------------------------------------------
    const effectiveBookmaker = bookmakerId ?? 8
    const url = buildUrl('/odds', {
      fixture:   fixtureId,
      bookmaker: effectiveBookmaker,
    })

    const res = await fetch(url, {
      headers: apiHeaders(),
      cache: 'no-store',
    })

    if (!res.ok) {
      return { odds: [], oddsUnavailable: true }
    }

    const json = await res.json() as { response?: RawOddsItem[] }

    if (!Array.isArray(json.response) || json.response.length === 0) {
      return { odds: [], oddsUnavailable: false }
    }

    // ------------------------------------------------------------------
    // 3. Map API response → OddsValue[] (v2: uses resolveV2OddsEntry)
    // ------------------------------------------------------------------
    const mappedOdds: OddsValue[] = []

    for (const item of json.response) {
      for (const bookmaker of (item.bookmakers ?? [])) {
        for (const bet of (bookmaker.bets ?? [])) {
          for (const val of (bet.values ?? [])) {
            // v2 handler covers bet.id 4, 5, 7, 57 with correct labels
            const v2Entry = resolveV2OddsEntry(bet.id, val.value, bookmaker.name, val.odd)
            if (v2Entry !== null) {
              mappedOdds.push(v2Entry)
              continue
            }
            // Fallback: legacy resolveMarket for bet.id 1 (1X2) and 8 (AH)
            const market = resolveMarket(bet.id, val.value)
            if (market === null) continue
            mappedOdds.push({
              bookmaker: bookmaker.name,
              market,
              label:     val.value,
              value:     parseFloat(val.odd),
            })
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // 4. Write to odds_cache (upsert – update on conflict)
    // ------------------------------------------------------------------
    const now        = new Date()
    const expiresAt  = new Date(now.getTime() + 4 * 60 * 60 * 1000) // +4 hours

    // The Supabase client lacks generated types for odds_cache — cast through
    // unknown to avoid TS2353 "Object literal may only specify known properties".
    await (supabase
      .from('odds_cache')
      .upsert(
        {
          fixture_id: fixtureId,
          odds_data:  mappedOdds,
          fetched_at: now.toISOString(),
          expires_at: expiresAt.toISOString(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as unknown as any,
        { onConflict: 'fixture_id' },
      ))

    return { odds: mappedOdds, oddsUnavailable: false }
  } catch {
    return { odds: [], oddsUnavailable: true }
  }
}

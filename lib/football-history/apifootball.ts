// lib/football-history/apifootball.ts
// Team match-history from apifootball.com. One get_H2H call per fixture returns BOTH teams'
// last-10 results (+ head-to-head), from which we estimate recency-weighted attack/defence.
// Server-only. Reads APIFOOTBALL_KEY/URL lazily so the app works with no key (advisory degrades off).
//
// HONEST: this feeds an ADVISORY lean only. Backtested skill is negative on every market
// (pedlas_v2.md / memory) — it never changes odds or EV.

import 'server-only'

import type { MatchResult } from '../pedlas/predict'

const DEFAULT_BASE = 'https://apiv3.apifootball.com'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // form changes slowly — cache 6h

export interface TeamForm { attack: number; defense: number; n: number }
export interface FixtureForm { home: TeamForm; away: TeamForm }

interface RawResult {
  match_date?: string
  match_hometeam_name?: string
  match_awayteam_name?: string
  match_hometeam_score?: string
  match_awayteam_score?: string
}

const cache = new Map<string, { expires: number; form: FixtureForm | null }>()

function tokens(s: string): Set<string> {
  return new Set((s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean))
}
function sim(a: string, b: string): number {
  const A = tokens(a), B = tokens(b)
  let c = 0
  for (const x of A) if (B.has(x)) c++
  return c
}

/** Recency-weighted attack/defence from clean MatchResult rows (the history store shape). */
export function formFromMatchResults(results: MatchResult[], team: string): TeamForm {
  const sorted = [...results].sort((x, y) => (y.date ?? '').localeCompare(x.date ?? ''))
  let wScored = 0, wConceded = 0, wsum = 0, n = 0, k = 0
  for (const r of sorted.slice(0, 10)) {
    if (Number.isNaN(r.hg) || Number.isNaN(r.ag)) continue
    const isHome = sim(r.home, team) >= sim(r.away, team)
    wScored += Math.pow(0.85, k) * (isHome ? r.hg : r.ag)
    wConceded += Math.pow(0.85, k) * (isHome ? r.ag : r.hg)
    wsum += Math.pow(0.85, k); k++; n++
  }
  return wsum > 0 ? { attack: wScored / wsum, defense: wConceded / wsum, n } : { attack: 1.3, defense: 1.3, n: 0 }
}

export interface LeagueEvent extends MatchResult { matchId: string; leagueId: number }

/** Fetch finished matches for a league/date-range (for the history-store ETL). One get_events call. */
export async function getLeagueEvents(leagueId: number, from: string, to: string): Promise<LeagueEvent[]> {
  const key = process.env.APIFOOTBALL_KEY?.trim()
  if (!key) return []
  const base = process.env.APIFOOTBALL_URL?.trim() || DEFAULT_BASE
  const url = `${base}/?action=get_events&from=${from}&to=${to}&league_id=${leagueId}&APIkey=${key}`
  try {
    const j = await (await fetch(url, { cache: 'no-store' })).json().catch(() => null) as Record<string, string>[] | null
    if (!Array.isArray(j)) return []
    return j
      .filter(e => e.match_status === 'Finished' && e.match_hometeam_score !== '' && e.match_id)
      .map(e => ({
        matchId: e.match_id, leagueId, date: e.match_date,
        home: e.match_hometeam_name, away: e.match_awayteam_name,
        hg: Number(e.match_hometeam_score), ag: Number(e.match_awayteam_score),
      }))
  } catch { return [] }
}

/** Recency-weighted attack/defence for `team` from its recent results (newest weighted most). */
export function formFrom(results: RawResult[], team: string): TeamForm {
  const sorted = [...results].sort((x, y) => (y.match_date ?? '').localeCompare(x.match_date ?? ''))
  let wScored = 0, wConceded = 0, wsum = 0, n = 0, k = 0
  for (const r of sorted.slice(0, 10)) {
    const hg = Number(r.match_hometeam_score), ag = Number(r.match_awayteam_score)
    if (Number.isNaN(hg) || Number.isNaN(ag)) continue
    const isHome = sim(r.match_hometeam_name ?? '', team) >= sim(r.match_awayteam_name ?? '', team)
    const scored = isHome ? hg : ag
    const conceded = isHome ? ag : hg
    const w = Math.pow(0.85, k++) // recency decay
    wScored += w * scored; wConceded += w * conceded; wsum += w; n++
  }
  return wsum > 0 ? { attack: wScored / wsum, defense: wConceded / wsum, n } : { attack: 1.3, defense: 1.3, n: 0 }
}

/** Fetch both teams' recent form for a fixture via one get_H2H call. null when unavailable. */
export async function getFixtureForm(home: string, away: string): Promise<FixtureForm | null> {
  const key = process.env.APIFOOTBALL_KEY?.trim()
  if (!key) return null
  const base = process.env.APIFOOTBALL_URL?.trim() || DEFAULT_BASE

  const ck = `${home}|${away}`
  const hit = cache.get(ck)
  if (hit && hit.expires > Date.now()) return hit.form

  const url = `${base}/?action=get_H2H&firstTeam=${encodeURIComponent(home)}&secondTeam=${encodeURIComponent(away)}&APIkey=${key}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
    if (!res.ok) { cache.set(ck, { expires: Date.now() + CACHE_TTL_MS, form: null }); return null }
    const j = await res.json().catch(() => null) as
      { firstTeam_lastResults?: RawResult[]; secondTeam_lastResults?: RawResult[] } | null
    const hr = j?.firstTeam_lastResults ?? []
    const ar = j?.secondTeam_lastResults ?? []
    const form: FixtureForm | null = (hr.length || ar.length)
      ? { home: formFrom(hr, home), away: formFrom(ar, away) }
      : null
    cache.set(ck, { expires: Date.now() + CACHE_TTL_MS, form })
    return form
  } catch {
    cache.set(ck, { expires: Date.now() + CACHE_TTL_MS, form: null })
    return null
  } finally {
    clearTimeout(timer)
  }
}

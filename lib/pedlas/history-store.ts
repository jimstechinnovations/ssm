// lib/pedlas/history-store.ts
// Supabase-backed results corpus → serve team form with ZERO live apifootball calls (rate-limit-proof).
// Populated by the ETL (lib/football-history getLeagueEvents → upsert). Server-only. Degrades to []
// when the table is missing (migration 004 not yet applied) so the live builder still works.

import 'server-only'

import { createServerClient } from '../supabase/server'
import type { MatchResult } from './predict'
import type { LeagueEvent } from '../football-history/apifootball'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Upsert league events into match_history. Returns rows written (0 on failure). */
export async function upsertMatches(events: LeagueEvent[]): Promise<number> {
  if (!events.length) return 0
  try {
    const supabase = createServerClient()
    const rows = events.map(e => ({
      match_id: e.matchId, league_id: e.leagueId, match_date: e.date,
      home_name: e.home, away_name: e.away, home_goals: e.hg, away_goals: e.ag,
    }))
    const { error } = await (supabase.from('match_history').upsert(rows as unknown as any, { onConflict: 'match_id' }))
    return error ? 0 : rows.length
  } catch { return 0 }
}

/** A team's recent results (either side) strictly before `beforeISO`. [] when store is empty/missing. */
export async function getTeamRecent(team: string, beforeISO: string, limit = 12): Promise<MatchResult[]> {
  try {
    const supabase = createServerClient()
    const before = beforeISO.slice(0, 10)
    const { data, error } = await (supabase
      .from('match_history')
      .select('match_date, home_name, away_name, home_goals, away_goals')
      .or(`home_name.eq.${team},away_name.eq.${team}`)
      .lt('match_date', before)
      .order('match_date', { ascending: false })
      .limit(limit)) as { data: any[] | null; error: unknown }
    if (error || !data) return []
    return data.map(r => ({ date: r.match_date, home: r.home_name, away: r.away_name, hg: r.home_goals, ag: r.away_goals }))
  } catch { return [] }
}

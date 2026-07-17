// lib/history/sofascore.ts
// Sofascore results via the debug Chrome (:9222). Direct fetch is Cloudflare-blocked (403), but an
// in-page fetch from a real sofascore.com tab passes. For each team we search → team id → recent
// finished matches, and store them under the SUPPLIED (bookmaker) name so getTeamRecent() finds them.
// The team's side in each match is matched by id (exact), not fuzzy name — robust to naming.

import 'server-only'
import { chromium, type Page } from 'playwright'
import { upsertMatches } from '../pedlas/history-store'
import type { LeagueEvent } from '../football-history/apifootball'

const CDP = 'http://127.0.0.1:9222'
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** In-page GET (runs inside the sofascore tab so Cloudflare clears it). */
async function apiGet<T = unknown>(page: Page, url: string): Promise<T | null> {
  return page.evaluate(async (u) => {
    try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); if (!r.ok) return null; return await r.json() } catch { return null }
  }, url) as Promise<T | null>
}

/** Recent finished matches for a team (searched by name), as LeagueEvents keyed to `bookName`. */
export async function fetchTeamHistory(page: Page, bookName: string): Promise<LeagueEvent[]> {
  const search = await apiGet<{ results?: { type: string; entity?: { id: number; name: string } }[] }>(
    page, `https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(bookName)}`)
  const team = search?.results?.find(r => r.type === 'team')?.entity
  if (!team) return []
  const ev = await apiGet<{ events?: SofaEvent[] }>(page, `https://api.sofascore.com/api/v1/team/${team.id}/events/last/0`)
  const finished = (ev?.events ?? []).filter(e => e.status?.type === 'finished' && e.homeScore?.current != null && e.awayScore?.current != null)
  return finished.map(e => {
    const teamIsHome = e.homeTeam.id === team.id
    return {
      matchId: `sofa-${e.id}`,
      leagueId: e.tournament?.uniqueTournament?.id ?? 0,
      date: new Date(e.startTimestamp * 1000).toISOString().slice(0, 10),
      home: teamIsHome ? bookName : e.homeTeam.name,   // put the bookmaker name on the team's side
      away: teamIsHome ? e.awayTeam.name : bookName,
      hg: e.homeScore!.current!,
      ag: e.awayScore!.current!,
    }
  })
}

interface SofaEvent {
  id: number
  startTimestamp: number
  status?: { type?: string }
  homeTeam: { id: number; name: string }
  awayTeam: { id: number; name: string }
  homeScore?: { current?: number }
  awayScore?: { current?: number }
  tournament?: { uniqueTournament?: { id?: number } }
}

export interface SyncResult { teams: number; found: number; rows: number; needBrowser?: boolean }

/** Sync Sofascore history for a set of bookmaker team names into match_history (via the debug Chrome). */
export async function syncSofascore(teamNames: string[]): Promise<SyncResult> {
  const teams = [...new Set(teamNames.map(t => t.trim()).filter(Boolean))]
  try { const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2500) }); if (!r.ok) throw new Error() }
  catch { return { teams: teams.length, found: 0, rows: 0, needBrowser: true } }

  const browser = await chromium.connectOverCDP(CDP)
  try {
    const ctx = browser.contexts()[0]
    const page = await ctx.newPage()
    await page.goto('https://www.sofascore.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
    await page.waitForTimeout(3500)

    let found = 0, rows = 0
    const batch: LeagueEvent[] = []
    for (const name of teams) {
      const hist = await fetchTeamHistory(page, name).catch(() => [] as LeagueEvent[])
      if (hist.length) { found++; batch.push(...hist) }
      await sleep(250) // be gentle with Sofascore
    }
    if (batch.length) rows = await upsertMatches(batch)
    await page.close()
    return { teams: teams.length, found, rows }
  } finally { await browser.close() }
}

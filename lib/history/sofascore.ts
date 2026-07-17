// lib/history/sofascore.ts
// Sofascore results via the debug Chrome (:9222). Direct fetch is Cloudflare-blocked (403); an
// in-page fetch from a real sofascore.com tab passes. For each GAME (home vs away) we fetch:
//   • H2H — the two teams' own past meetings (stored with BOTH bookmaker names), for the insight graph
//   • team form — each team's recent matches (bookmaker name on that team's side), for the engine
// Team identity is matched by Sofascore id (exact), never fuzzy name.

import 'server-only'
import { chromium, type Page } from 'playwright'
import { upsertMatches } from '../pedlas/history-store'
import type { LeagueEvent } from '../football-history/apifootball'

const CDP = 'http://127.0.0.1:9222'
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

interface SofaEvent {
  id: number; startTimestamp: number; status?: { type?: string }
  homeTeam: { id: number; name: string }; awayTeam: { id: number; name: string }
  homeScore?: { current?: number }; awayScore?: { current?: number }
  tournament?: { uniqueTournament?: { id?: number } }
}

async function apiGet<T = unknown>(page: Page, url: string): Promise<T | null> {
  return page.evaluate(async (u) => {
    try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); if (!r.ok) return null; return await r.json() } catch { return null }
  }, url) as Promise<T | null>
}

async function findTeam(page: Page, name: string): Promise<{ id: number; name: string } | null> {
  const s = await apiGet<{ results?: { type: string; entity?: { id: number; name: string } }[] }>(page, `https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(name)}`)
  const t = s?.results?.find(r => r.type === 'team')?.entity
  return t ? { id: t.id, name: t.name } : null
}

async function teamFinished(page: Page, teamId: number, pages = 2): Promise<SofaEvent[]> {
  const out: SofaEvent[] = []
  for (let p = 0; p < pages; p++) {
    const d = await apiGet<{ events?: SofaEvent[] }>(page, `https://api.sofascore.com/api/v1/team/${teamId}/events/last/${p}`)
    const ev = (d?.events ?? []).filter(e => e.status?.type === 'finished' && e.homeScore?.current != null && e.awayScore?.current != null)
    out.push(...ev); if (ev.length === 0) break; await sleep(150)
  }
  return out
}

/** A finished event → a form row with `bookName` on the queried team's side. */
function formRow(e: SofaEvent, teamId: number, bookName: string): LeagueEvent {
  const home = e.homeTeam.id === teamId
  return { matchId: `sofa-${e.id}`, leagueId: e.tournament?.uniqueTournament?.id ?? 0, date: new Date(e.startTimestamp * 1000).toISOString().slice(0, 10), home: home ? bookName : e.homeTeam.name, away: home ? e.awayTeam.name : bookName, hg: e.homeScore!.current!, ag: e.awayScore!.current! }
}
/** A finished H2H event → a row with BOTH bookmaker names (distinct id so it doesn't clash with form). */
function h2hRow(e: SofaEvent, homeId: number, homeBook: string, awayBook: string): LeagueEvent {
  const homeIsHome = e.homeTeam.id === homeId
  return { matchId: `sofa-h2h-${e.id}`, leagueId: e.tournament?.uniqueTournament?.id ?? 0, date: new Date(e.startTimestamp * 1000).toISOString().slice(0, 10), home: homeIsHome ? homeBook : awayBook, away: homeIsHome ? awayBook : homeBook, hg: e.homeScore!.current!, ag: e.awayScore!.current! }
}

export interface GamePair { home: string; away: string }
export interface SyncResult { games: number; processed: number; withH2H: number; withForm: number; rows: number; more: boolean; needBrowser?: boolean }

/** Sync a BOUNDED batch (default 12 games) so one request can't tie up the browser; the caller can
 *  re-run to cover more (`more` says whether games remain). Each team is looked up at most once. */
export async function syncSofascoreGames(games: GamePair[], limit = 12): Promise<SyncResult> {
  try { const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2500) }); if (!r.ok) throw new Error() }
  catch { return { games: games.length, processed: 0, withH2H: 0, withForm: 0, rows: 0, more: games.length > 0, needBrowser: true } }

  const batchGames = games.slice(0, limit)
  const browser = await chromium.connectOverCDP(CDP)
  let page: Page | null = null
  try {
    const ctx = browser.contexts()[0]
    page = await ctx.newPage()
    await page.goto('https://www.sofascore.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    await page.waitForTimeout(3000)

    const idCache = new Map<string, { id: number; name: string } | null>()
    const team = async (name: string) => { if (!idCache.has(name)) idCache.set(name, await findTeam(page!, name).catch(() => null)); return idCache.get(name)! }

    const batch: LeagueEvent[] = []
    let withH2H = 0, withForm = 0
    for (const g of batchGames) {
      const [th, ta] = await Promise.all([team(g.home), team(g.away)])
      let form = false, h2h = false
      if (th) { const ev = await teamFinished(page, th.id, 1).catch(() => [] as SofaEvent[]); if (ev.length) { form = true; for (const e of ev) batch.push(formRow(e, th.id, g.home))
        if (ta) for (const e of ev.filter(x => x.homeTeam.id === ta.id || x.awayTeam.id === ta.id)) { h2h = true; batch.push(h2hRow(e, th.id, g.home, g.away)) } } }
      if (ta) { const ev = await teamFinished(page, ta.id, 1).catch(() => [] as SofaEvent[]); if (ev.length) { form = true; for (const e of ev) batch.push(formRow(e, ta.id, g.away)) } }
      if (form) withForm++; if (h2h) withH2H++
      await sleep(150)
    }
    const rows = batch.length ? await upsertMatches(batch) : 0
    return { games: games.length, processed: batchGames.length, withH2H, withForm, rows, more: games.length > batchGames.length }
  } finally { await page?.close().catch(() => {}); await browser.close() }
}

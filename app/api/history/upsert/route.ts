/**
 * POST /api/history/upsert — store match rows (from the out-of-process Sofascore sync script) into
 * match_history. Body: { events: LeagueEvent[] }. Keeps DB access server-side.
 */

import { upsertMatches } from '@/lib/pedlas/history-store'
import type { LeagueEvent } from '@/lib/football-history/apifootball'

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  let body: { events?: LeagueEvent[] }
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const events = Array.isArray(body.events) ? body.events : []
  if (events.length === 0) return Response.json({ rows: 0 })
  const rows = await upsertMatches(events)
  return Response.json({ rows })
}

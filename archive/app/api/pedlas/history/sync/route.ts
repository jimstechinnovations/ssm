/**
 * POST /api/pedlas/history/sync — populate the match_history store from apifootball get_events.
 * Body: { leagueIds?: number[], from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }
 * One get_events call per league (cheap) → upsert. Run on a schedule (e.g. daily) to keep the store
 * fresh so the live builder serves team form with no per-request apifootball calls.
 */

import { z } from 'zod'
import { getLeagueEvents } from '@/lib/football-history/apifootball'
import { upsertMatches } from '@/lib/pedlas/history-store'

export const runtime = 'nodejs'

// In-season leagues that returned data when probed; override via body.leagueIds.
const DEFAULT_LEAGUES = [118, 253, 307, 219, 332, 99, 209]

const SyncSchema = z.object({
  leagueIds: z.array(z.number().int().positive()).max(40).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export async function POST(request: Request): Promise<Response> {
  let body: unknown = {}
  try { body = await request.json() } catch { /* empty body OK */ }
  const parsed = SyncSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return Response.json({ error: 'Validation failed', issues: parsed.error.issues.map(i => i.message) }, { status: 400 })
  }

  const leagueIds = parsed.data.leagueIds ?? DEFAULT_LEAGUES
  const from = parsed.data.from ?? '2026-01-01'
  const to = parsed.data.to ?? new Date().toISOString().slice(0, 10)

  const perLeague: Record<number, number> = {}
  let total = 0
  for (const id of leagueIds) {
    const events = await getLeagueEvents(id, from, to)
    const written = await upsertMatches(events)
    perLeague[id] = written
    total += written
  }

  return Response.json({ synced: total, perLeague, from, to })
}

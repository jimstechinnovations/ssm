/**
 * POST /api/sessions/[id]/fetch-history — pull recent results from Sofascore (via the debug Chrome)
 * for every team in this session's games and store them, so history/enrichment/gating light up.
 * Needs the browser up on :9222 (same one used for placement).
 */

import { getSession, listSessionSlips } from '@/lib/sessions/store'
import { syncSofascore } from '@/lib/history/sofascore'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  const [base] = await listSessionSlips(session.id, { withLegs: true, limit: 1 })
  const legs = (base?.legs as Array<{ game: string }> | undefined) ?? []
  const teams = legs.flatMap(l => l.game.split(' vs ').map(s => s.trim()))
  if (teams.length === 0) return Response.json({ error: 'No games to fetch history for' }, { status: 400 })

  const result = await syncSofascore(teams)
  if (result.needBrowser) return Response.json({ error: 'Browser not up on :9222 — launch it on Config first' }, { status: 409 })
  return Response.json(result)
}

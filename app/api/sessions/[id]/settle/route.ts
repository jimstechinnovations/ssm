/**
 * POST /api/sessions/[id]/settle — refresh live results for EVERY game in the session and settle
 * placed slips. Two independent things happen:
 *   1. GAME OUTCOMES: we fetch results for all distinct fixtures (every slip shares the pool) and
 *      persist them to session.meta.gameResults — so the UI keeps showing each game's outcome as it
 *      finishes, EVEN for slips already lost (one leg cut it, but we still track the rest).
 *   2. SLIP SETTLEMENT: still-unsettled slips are settled with early-cut (lost the moment one leg is
 *      contradicted; won when all legs finished+correct; else pending). Re-runnable as games finish.
 */

import { getSession } from '@/lib/sessions/store'
import { settleSessionNow } from '@/lib/sessions/settle'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  return Response.json(await settleSessionNow(session))
}

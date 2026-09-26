/**
 * POST /api/sessions/[id]/requeue  { statuses?: ('skipped'|'failed')[] }
 * Return 'skipped' (odds drifted below target — nothing staked) and/or 'failed' (retries exhausted, nothing
 * staked) slips to 'pending' with a fresh attempts budget, so the next live run gives them another shot at
 * current (re-checked) odds. Never touches placed/won/lost/verify slips. Does not itself start placing —
 * call /place afterward.
 */

import { z } from 'zod'
import { getSession, requeueSession } from '@/lib/sessions/store'

export const runtime = 'nodejs'

const Body = z.object({ statuses: z.array(z.enum(['skipped', 'failed'])).min(1).optional() })

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  let statuses: ('skipped' | 'failed')[] | undefined
  try { const b = await request.json(); statuses = Body.parse(b ?? {}).statuses } catch { /* default both */ }
  const n = await requeueSession(session.id, statuses)
  return Response.json({ requeued: n })
}

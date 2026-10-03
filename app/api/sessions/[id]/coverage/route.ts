/**
 * GET /api/sessions/[id]/coverage[?combine=day][&site=1] — "do we have enough survivors?", both ways.
 *
 * Mode is automatic:
 *  - `live`: the session has placed slips → the family is what was actually staked; finished games settle
 *    legs, games IN PLAY kill legs that can no longer win (as SportyBet does), and the rest is simulated.
 *  - `plan`: nothing placed yet → the family is the built slips, before a naira is staked: which games are
 *    one-sided, how deep at least one slip survives, and what more slips/budget would buy.
 *
 * `combine=day` adds every other session created the same day that has placed slips (one budget is often
 * split across several sessions — the operator thinks in "my 16 slips", not per session).
 * `site=1` also reads the account's open bets from SportyBet (needs the prepared browser) and matches each
 * to our slip by its exact selections, so the app's count and the site's count can be reconciled.
 * Read-only. The maths is in lib/pedlas/survivors.ts.
 */

import { getSession } from '@/lib/sessions/store'
import { runCoverage } from '@/lib/pedlas/coverage-run'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const url = new URL(request.url)
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  const r = await runCoverage(session, { combine: url.searchParams.get('combine') === 'day', site: url.searchParams.get('site') === '1' })
  return 'error' in r && !('mode' in r) ? Response.json(r, { status: 409 }) : Response.json(r)
}

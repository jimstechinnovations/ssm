/**
 * The live monitor for a session (lib/monitor/tick.ts).
 *   GET  → the feed (newest last)
 *   POST { force?: boolean } → run a tick (settle → survivors → placement check → AI update, fact-checked);
 *        within 4 minutes of the last update it just returns the feed, so any number of open pages can
 *        poll it without hammering SportyBet.
 */
import { getSession } from '@/lib/sessions/store'
import { monitorTick, type MonitorEvent } from '@/lib/monitor/tick'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  const feed = ((session.meta ?? {}) as { monitor?: { feed?: MonitorEvent[] } }).monitor?.feed ?? []
  return Response.json({ feed })
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  const body = await request.json().catch(() => ({})) as { force?: boolean }
  try { return Response.json(await monitorTick(session.id, { force: body.force === true })) }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }) }
}

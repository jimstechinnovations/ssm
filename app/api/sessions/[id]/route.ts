/**
 * GET /api/sessions/[id] — one session with its slips + scoreboard.
 * Accepts the UUID or the S-XXXXXX code. Settle-on-load (pulling live results into won/lost) is a
 * later hook; for now this returns the persisted state so the UI can render + poll.
 *
 * Reconciliation: when a game was suspended/void at (or after) placement, the real bet is a SHORTER
 * combo. Each slip's legs carry `suspended:true` on the dropped legs, so we surface the reconciled
 * leg-count / odds / payout alongside the original — the table shows the shorter-combo values (with the
 * original struck-through). Original fields are never overwritten, so nothing is lost.
 */

import { getSession, listSessionSlips, countSessionSlips, scoreboards } from '@/lib/sessions/store'
import { getBookConfig } from '@/lib/books/config-store'
import { getBook } from '@/lib/books/registry'
import { boostFromTable, boostedPayout } from '@/lib/pedlas/boost'

export const runtime = 'nodejs'

type Leg = { odds?: number; suspended?: boolean }

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  const url = new URL(request.url)
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 50))
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
  // withLegs=1 returns each slip's full legs (needed by the placer to build booking codes). The UI omits
  // legs for speed — but we still pull them here to compute the reconciled shorter-combo values, then
  // strip them from the response unless the caller (the placer) explicitly asked for them.
  const withLegs = url.searchParams.get('withLegs') === '1'
  // Server-side filter / search / sort so they work across the WHOLE book, not just the visible page.
  const status = url.searchParams.get('status') || 'all'
  const search = url.searchParams.get('q') || ''
  const sortBy = url.searchParams.get('sort') || 'slipId'
  const sortDir = (url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc'
  const filtered = status !== 'all' || Boolean(search.trim())
  const listOpts = { limit, offset, withLegs: true, status, search, sortBy, sortDir }
  const [rawSlips, sb, filteredTotal] = await Promise.all([
    listSessionSlips(session.id, listOpts),
    scoreboards([{ id: session.id, slipCount: session.slipCount }]),
    filtered ? countSessionSlips(session.id, { status, search }) : Promise.resolve(null),
  ])

  // Book boost/cap once, so we can price each reconciled (shorter) combo exactly as the book would.
  const cfg = await getBookConfig(session.bookIds[0]); const adapter = getBook(session.bookIds[0])
  const boost = cfg.boost ? boostFromTable(cfg.boost) : adapter.boostFor
  const cap = Math.min(cfg.maxPayout ?? adapter.maxPayout, adapter.maxPayout)

  const slips = rawSlips.map(s => {
    const legs = (s.legs as Leg[]) ?? []
    const dropped = legs.filter(l => l.suspended)
    let reconciled: { legCount: number; combinedOdds: number; payout: number } | null = null
    if (dropped.length) {
      const live = legs.filter(l => !l.suspended)
      const odds = live.reduce((p, l) => p * (l.odds || 1), 1)
      reconciled = { legCount: live.length, combinedOdds: odds, payout: Math.min(boostedPayout(s.stake, odds, live.length, boost), cap) }
    }
    // strip the heavy legs array from the UI response (the placer path keeps it)
    const { legs: _legs, ...rest } = s
    return withLegs ? { ...rest, legs, reconciled } : { ...rest, reconciled }
  })

  const total = filteredTotal ?? session.slipCount ?? sb[session.id]?.slips ?? slips.length
  return Response.json({ session, slips, summary: sb[session.id], page: { offset, limit, total } })
}

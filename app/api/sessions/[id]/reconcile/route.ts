/**
 * POST /api/sessions/[id]/reconcile — when a game is suspended/void mid-run, the placed slip is a leg
 * short and its real payout drops. This detects suspended fixtures (SportyBet upcoming feed = not
 * active), marks those legs `suspended:true` in each placed slip's legs, and persists it. The slip/UI
 * then show the ORIGINAL payout struck-through and the reconciled (shorter-combo) payout below.
 * Read-mostly; only writes the legs jsonb of affected slips (never touches status).
 */

import { getSession, listPlacedSlipsWithLegs } from '@/lib/sessions/store'
import { createServerClient } from '@/lib/supabase/server'
import { getBookConfig } from '@/lib/books/config-store'
import { getBook } from '@/lib/books/registry'
import { boostFromTable, reconciledPayout } from '@/lib/pedlas/boost'
import { fetchResults } from '@/lib/pedlas/results'

// re-exported for callers that import it from this route (e.g. the settle route)
export { reconciledPayout }

export const runtime = 'nodejs'
export const maxDuration = 120

type Leg = { fixtureId: number; game?: string; line?: number; side?: string; odds?: number; suspended?: boolean }
const UA = 'Mozilla/5.0'

/** Fixtures whose Over/Under 4.5 market is NOT active in the upcoming feed = suspended/unavailable. */
async function suspendedFixtures(ids: number[]): Promise<Set<number>> {
  const want = new Set(ids); const active = new Set<number>()
  for (let pg = 1; pg <= 12; pg++) {
    const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=18&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA } }).catch(() => null)
    const j = r ? await r.json().catch(() => null) : null
    if (!j?.data?.tournaments) break
    for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
      const id = Number((ev.eventId || '').split(':').pop()); if (!want.has(id)) continue
      const m = (ev.markets || []).find((x: { specifier?: string }) => x.specifier === 'total=4.5')
      const ok = m && (m.status === undefined || m.status === 0) && (m.outcomes || []).every((o: { isActive?: number }) => o.isActive !== 0)
      if (ok) active.add(id)
    }
    if (pg * 100 >= (j.data.totalNum ?? 0)) break
  }
  // suspended = wanted but not found active in the upcoming feed
  return new Set([...want].filter(id => !active.has(id)))
}

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  const placed = (await listPlacedSlipsWithLegs(session.id)).filter(s => (s.legs as Leg[])?.length)
  if (placed.length === 0) return Response.json({ checked: 0, affected: 0, note: 'no placed slips' })

  const fixtureIds = [...new Set(placed.flatMap(s => (s.legs as Leg[]).map(l => l.fixtureId)))]
  const notActive = await suspendedFixtures(fixtureIds)
  // A FINISHED game is also absent from the upcoming feed — but it played, so it is NOT a dropped leg.
  // Only games that are missing from the feed AND have not finished are genuinely suspended/void/pulled.
  // (Without this, running reconcile after kickoff would mark every played game as "suspended".)
  const results = await fetchResults([...notActive])
  const suspended = new Set([...notActive].filter(id => !results.get(id)?.finished))
  if (suspended.size === 0) return Response.json({ checked: placed.length, affected: 0, suspendedFixtures: [], note: 'no void legs (games either live or finished)' })

  const cfg = await getBookConfig(session.bookIds[0]); const adapter = getBook(session.bookIds[0])
  const boost = cfg.boost ? boostFromTable(cfg.boost) : adapter.boostFor
  const cap = Math.min(cfg.maxPayout ?? adapter.maxPayout, adapter.maxPayout)
  const supabase = createServerClient()

  let affected = 0
  const samples: Array<{ slipId: number; suspended: string[]; original: number; reconciled: number }> = []
  for (const s of placed) {
    const legs = s.legs as Leg[]
    const hits = legs.filter(l => suspended.has(l.fixtureId))
    if (hits.length === 0) continue
    const marked = legs.map(l => suspended.has(l.fixtureId) ? { ...l, suspended: true } : l)
    const rec = reconciledPayout(marked, Number(s.stake), boost, cap)
    await (supabase.from('pedla_placements') as unknown as { update: (v: unknown) => { eq: (a: string, b: unknown) => { eq: (c: string, d: unknown) => Promise<unknown> } } })
      .update({ legs: marked }).eq('session_id', session.id).eq('slip_id', s.slipId)
    affected++
    if (samples.length < 5) samples.push({ slipId: s.slipId, suspended: hits.map(h => h.game || String(h.fixtureId)), original: s.potentialPayout ?? 0, reconciled: rec })
  }
  return Response.json({ checked: placed.length, affected, suspendedFixtures: [...suspended], samples })
}

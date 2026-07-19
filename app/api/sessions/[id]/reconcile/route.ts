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

type Leg = { fixtureId: number; game?: string; line?: number; side?: string; odds?: number; kickoff?: string; suspended?: boolean }

// A game is genuinely VOID/ABANDONED only if its kickoff is well in the past (a normal match + stoppage
// would be over) AND it still has no finished result. Being absent from the upcoming feed is NOT a
// reliable signal — an in-play game (just kicked off) and a game beyond the near-term feed window are
// both "not in the feed", yet neither is void. Anchoring on kickoff-passed-with-no-result avoids
// false-flagging in-play and future games (the bug that once dropped live legs off every slip).
const VOID_AFTER_MS = 3.5 * 60 * 60 * 1000

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  const placed = (await listPlacedSlipsWithLegs(session.id)).filter(s => (s.legs as Leg[])?.length)
  if (placed.length === 0) return Response.json({ checked: 0, affected: 0, note: 'no placed slips' })

  // Earliest kickoff we saw for each fixture (all slips share the pool, so any leg carries it).
  const kickoffOf = new Map<number, number>()
  for (const s of placed) for (const l of s.legs as Leg[]) {
    const t = l.kickoff ? Date.parse(l.kickoff) : NaN
    if (Number.isFinite(t) && !kickoffOf.has(l.fixtureId)) kickoffOf.set(l.fixtureId, t)
  }
  const fixtureIds = [...new Set(placed.flatMap(s => (s.legs as Leg[]).map(l => l.fixtureId)))]
  const results = await fetchResults(fixtureIds)
  const now = Date.now()
  // void = kickoff long past (would have finished) AND no finished result. In-play & future games excluded.
  const suspended = new Set(fixtureIds.filter(id => {
    if (results.get(id)?.finished) return false                 // played out normally
    const ko = kickoffOf.get(id)
    return ko != null && (now - ko) > VOID_AFTER_MS             // should be over by now, but never resulted
  }))
  const cfg = await getBookConfig(session.bookIds[0]); const adapter = getBook(session.bookIds[0])
  const boost = cfg.boost ? boostFromTable(cfg.boost) : adapter.boostFor
  const cap = Math.min(cfg.maxPayout ?? adapter.maxPayout, adapter.maxPayout)
  const supabase = createServerClient()

  // IDEMPOTENT: recompute every slip's suspended flags from scratch — SET on currently-void legs, CLEAR
  // on all others. So a re-run self-heals stale flags (e.g. a game that looked void mid-run but has since
  // kicked off / been re-listed) instead of leaving legs wrongly dropped. Only writes slips that changed.
  // NOTE: the placer records droppedFixtures at placement (the ground truth); this handles legs that go
  // void AFTER placement — it never re-adds a leg SportyBet actually took, only reflects post-hoc voids.
  let affected = 0, cleared = 0
  const samples: Array<{ slipId: number; suspended: string[]; original: number; reconciled: number }> = []
  for (const s of placed) {
    const legs = s.legs as Leg[]
    const marked: Leg[] = legs.map(l => {
      const shouldSuspend = suspended.has(l.fixtureId)
      if (shouldSuspend === Boolean(l.suspended)) return l
      const { suspended: _drop, ...rest } = l
      return shouldSuspend ? { ...rest, suspended: true } : rest
    })
    const changed = marked.some((m, i) => Boolean(m.suspended) !== Boolean(legs[i].suspended))
    if (!changed) continue
    await (supabase.from('pedla_placements') as unknown as { update: (v: unknown) => { eq: (a: string, b: unknown) => { eq: (c: string, d: unknown) => Promise<unknown> } } })
      .update({ legs: marked }).eq('session_id', session.id).eq('slip_id', s.slipId)
    const hits = marked.filter(l => l.suspended)
    if (hits.length) { affected++; if (samples.length < 5) samples.push({ slipId: s.slipId, suspended: hits.map(h => h.game || String(h.fixtureId)), original: s.potentialPayout ?? 0, reconciled: reconciledPayout(marked, Number(s.stake), boost, cap) }) }
    else cleared++
  }
  return Response.json({ checked: placed.length, affected, cleared, suspendedFixtures: [...suspended], samples })
}

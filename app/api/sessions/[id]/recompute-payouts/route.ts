/**
 * POST /api/sessions/[id]/recompute-payouts — rewrite every slip's stored potential_payout from its
 * real combined odds using the book's CURRENT config (boost + max-win cap). Use after a cap/boost
 * correction so the table, the slip overlay, and /placements all agree and respect the true cap
 * (SportyBet ₦200M) — never an understated or stale value.
 */

import { getSession, listSessionSlips, updateSlipPayouts } from '@/lib/sessions/store'
import { getBookConfig } from '@/lib/books/config-store'
import { getBook } from '@/lib/books/registry'
import { boostedPayout, boostFromTable } from '@/lib/pedlas/boost'
import type { BoostFn } from '@/lib/pedlas/boost'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  const slips = await listSessionSlips(session.id, { limit: 2000 })
  if (slips.length === 0) return Response.json({ total: 0, changed: 0 })

  // Per-book: the verified boost table (or the adapter's, which is noBoost when unverified) + the
  // real cap (min of config and adapter, so we never exceed the book's actual max win).
  const bookIds = [...new Set(slips.map(s => s.bookId))]
  const perBook = new Map<string, { boost: BoostFn; cap: number }>()
  for (const bid of bookIds) {
    const cfg = await getBookConfig(bid)
    const adapter = getBook(bid)
    perBook.set(bid, { boost: cfg.boost ? boostFromTable(cfg.boost) : adapter.boostFor, cap: Math.min(cfg.maxPayout ?? adapter.maxPayout, adapter.maxPayout) })
  }

  const updates: { slipId: number; payout: number }[] = []
  for (const s of slips) {
    const b = perBook.get(s.bookId)
    if (!b || !s.combinedOdds) continue
    const payout = Math.min(boostedPayout(s.stake, s.combinedOdds, s.legCount, b.boost), b.cap)
    if (Math.abs((s.potentialPayout ?? 0) - payout) > 0.5) updates.push({ slipId: s.slipId, payout: Math.round(payout * 100) / 100 })
  }
  const changed = await updateSlipPayouts(session.id, updates)
  return Response.json({ total: slips.length, changed, cap: perBook.get(bookIds[0])?.cap })
}

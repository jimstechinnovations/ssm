/**
 * POST /api/books/[id]/capture-boost — measure the book's REAL boost from its own betslip and store
 * it (book_configs.boost_json) so the L/payout math uses real numbers, not a guess. Needs debug
 * Chrome on :9222 (launch via /api/browser). SportyBet is the wired book today.
 */

import { captureSportybetBoost, toBoostTable } from '@/lib/placement/capture-boost'
import { upsertBookConfig } from '@/lib/books/config-store'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  if (id !== 'sportybet') return Response.json({ error: `Boost capture is only wired for sportybet (got "${id}")` }, { status: 400 })

  let legCounts: number[] | undefined
  try { const b = await request.json(); if (Array.isArray(b?.legCounts)) legCounts = b.legCounts.map(Number) } catch { /* default */ }

  try {
    const rows = await captureSportybetBoost(legCounts)
    if (rows.length === 0) return Response.json({ error: 'Captured no rows — is the browser up and on sportybet.com?' }, { status: 502 })
    const table = toBoostTable(rows)
    const config = await upsertBookConfig({ bookId: id, boost: table })
    return Response.json({ captured: rows, table, saved: config != null })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}

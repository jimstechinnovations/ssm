/**
 * /api/placements — the money ledger.
 *   GET                       → placed slips (real by default) + ledger summary
 *   GET ?includeDryRun=1      → include simulated runs
 *   POST { action:'settle' }  → AUTO-settle every open slip from real match results
 *   POST { action:'settle', id, won, returned?, notes? } → MANUAL settle/override one slip
 *   POST { action:'grade', id } → grade one slip without settling (progress view)
 */

import { z } from 'zod'
import { listPlacements, listPlacementsPage, listOpenPlacements, settlePlacement, ledgerSummary } from '@/lib/placement/store'
import { gradeSlip } from '@/lib/placement/results'

export const runtime = 'nodejs'

const AutoSettleSchema = z.object({ action: z.literal('settle'), id: z.undefined().optional() })
const ManualSettleSchema = z.object({
  action: z.literal('settle'),
  id: z.string().uuid(),
  won: z.boolean(),
  returned: z.number().nonnegative().optional(),
  notes: z.string().max(500).optional(),
})
const GradeSchema = z.object({ action: z.literal('grade'), id: z.string().uuid() })

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const includeDryRun = url.searchParams.get('includeDryRun') === '1'
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 25))
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
  const search = url.searchParams.get('search') ?? ''
  const [page, summary] = await Promise.all([
    listPlacementsPage({ limit, offset, includeDryRun, search }),
    ledgerSummary(),
  ])
  return Response.json({ placements: page.rows, total: page.total, page: { limit, offset }, summary })
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  // grade one slip (no write)
  const grade = GradeSchema.safeParse(body)
  if (grade.success) {
    const row = (await listPlacements({ limit: 200, includeDryRun: true })).find(p => p.id === grade.data.id)
    if (!row) return Response.json({ error: 'Unknown placement id' }, { status: 404 })
    return Response.json({ grade: await gradeSlip(row.legs) })
  }

  // manual settle / override
  const manual = ManualSettleSchema.safeParse(body)
  if (manual.success) {
    const ok = await settlePlacement({
      id: manual.data.id,
      won: manual.data.won,
      returned: manual.data.returned ?? 0,
      settledBy: 'manual',
      notes: manual.data.notes,
    })
    return ok
      ? Response.json({ settled: 1, mode: 'manual' })
      : Response.json({ error: 'Settle failed (is migration 005_placements.sql applied?)' }, { status: 500 })
  }

  // auto-settle everything that has finished
  const auto = AutoSettleSchema.safeParse(body)
  if (!auto.success) {
    return Response.json({ error: 'Validation failed: expected {action:"settle"[,id,won]} or {action:"grade",id}' }, { status: 400 })
  }

  const open = await listOpenPlacements()
  const settledRows: { id: string; won: boolean; returned: number }[] = []
  const pending: { id: string; finished: number; total: number }[] = []

  for (const row of open) {
    const g = await gradeSlip(row.legs)
    if (!g.complete || g.won === null) {
      pending.push({ id: row.id, finished: g.finishedLegs, total: g.totalLegs })
      continue
    }
    // A won slip returns what the BOOK would pay (the site's potential win we recorded).
    const returned = g.won ? (row.potentialPayout ?? 0) : 0
    const ok = await settlePlacement({
      id: row.id, won: g.won, returned, legResults: g.legResults, settledBy: 'auto',
    })
    if (ok) settledRows.push({ id: row.id, won: g.won, returned })
  }

  return Response.json({
    settled: settledRows.length,
    mode: 'auto',
    rows: settledRows,
    pending,
    summary: await ledgerSummary(),
  })
}

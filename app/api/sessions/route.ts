/**
 * /api/sessions — the Bet-Manager session (pedlas_v3.md §1–3).
 *   POST { books[], date_from, date_to, budget, target_win, min_stake? }
 *        → build a PEDLA book per book, persist the session + its slips, return the session.
 *   GET  → list recent sessions (with a slip scoreboard each).
 *
 * Phase 2: sizing reuses the current quality builder (legs derived roughly from the target). The
 * covering-design engine that turns budget into guaranteed cutter-depth lands in Phase 3 and will
 * only change HOW slips are chosen — the session/persistence contract here stays the same.
 */

import { z } from 'zod'
import { getBook, BOOK_IDS } from '@/lib/books/registry'
import { getBookConfig } from '@/lib/books/config-store'
import { buildCoverageForAdapter } from '@/lib/pedlas/build-book'
import { createSession, updateSession, saveSessionSlips, listSessions, sessionSummary } from '@/lib/sessions/store'

export const runtime = 'nodejs'

const CreateSchema = z.object({
  books:      z.array(z.enum(BOOK_IDS)).min(1),
  date_from:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  budget:     z.number().positive().min(10),
  target_win: z.number().positive().min(100),
  min_stake:  z.number().positive().optional(),
  /** Legs per slip (the ~30–33 regime). If unset, derived from target_win. */
  leg_pref:   z.number().int().min(3).max(60).optional(),
  /** Selection window: only pick games kicking off ≥ this many minutes out, so none go live during
   *  the placement run. 30–60 min recommended. */
  selection_window_min: z.number().int().min(15).max(240).optional(),
}).refine(d => {
  const from = new Date(d.date_from), to = new Date(d.date_to)
  const maxTo = new Date(from); maxTo.setDate(maxTo.getDate() + 2)
  return to >= from && to <= maxTo
}, { message: 'date_to must be between date_from and date_from + 2 days' })

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = CreateSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Validation failed', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }, { status: 400 })
  }
  const req = parsed.data

  // Effective min stake = max(requested, every selected book's configured min) so no slip underflows.
  const cfgs = await Promise.all(req.books.map(getBookConfig))
  const minStake = Math.max(req.min_stake ?? 0, ...cfgs.map(c => c.minStake))
  const perBookBudget = Math.floor(req.budget / req.books.length)
  const windowMin = req.selection_window_min ?? 45   // default 45 min so no game goes live mid-run

  const session = await createSession({
    bookIds: req.books, dateFrom: req.date_from, dateTo: req.date_to,
    budget: req.budget, targetWin: req.target_win, minStake,
  })
  if (!session) return Response.json({ error: 'Could not create session (is migration 006 applied?)' }, { status: 500 })

  const bookResults: Array<{ bookId: string; slips?: number; legs?: number; pAnyWin?: number; medianPayout?: number; note?: string; error?: string; detail?: string }> = []
  const bookMetas: Record<string, unknown> = {}
  let totalSlips = 0
  let repL: number | undefined
  let repPool: number | undefined
  let repPAny: number | undefined

  for (const id of req.books) {
    const built = await buildCoverageForAdapter(getBook(id), {
      dateFrom: req.date_from, dateTo: req.date_to, budget: perBookBudget, stake: minStake,
      targetWin: req.target_win, legPref: req.leg_pref, minKickoffGapMinutes: windowMin,
    })
    if (!built.book || !built.slips) { bookResults.push({ bookId: id, error: built.error, detail: built.detail }); continue }
    const saved = await saveSessionSlips(session.id, id, built.slips)
    totalSlips += saved
    repL ??= built.book.L; repPool ??= built.book.poolSize; repPAny ??= built.book.pAnyWin
    bookMetas[id] = built.meta
    bookResults.push({ bookId: id, slips: saved, legs: built.book.L, pAnyWin: built.book.pAnyWin, medianPayout: built.book.medianPayout, note: built.book.note })
  }

  const ok = totalSlips > 0
  await updateSession(session.id, {
    status: ok ? 'placing' : 'failed',
    legCount: repL,
    slipCount: totalSlips,
    poolSize: repPool,
    meta: { perBookBudget, windowMin, pAnyWin: repPAny, books: bookResults, bookMetas },
  })

  return Response.json({
    session: { ...session, status: ok ? 'placing' : 'failed', legCount: repL, slipCount: totalSlips, poolSize: repPool },
    books: bookResults,
    summary: await sessionSummary(session.id),
  }, { status: ok ? 200 : 422 })
}

export async function GET(): Promise<Response> {
  const sessions = await listSessions()
  const withSummary = await Promise.all(sessions.map(async s => ({ ...s, summary: await sessionSummary(s.id) })))
  return Response.json({ sessions: withSummary })
}

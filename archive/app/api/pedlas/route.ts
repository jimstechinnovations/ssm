/**
 * POST /api/pedlas
 *
 * PEDLA multi-book builder. Select one or more bookmakers; each selected book gets its own
 * PEDLA book (a slip lives at exactly one bookmaker), built from that book's own odds feed
 * and payout rules (boost table, max-win cap) via its lib/books adapter. The budget is split
 * equally across the selected books.
 *
 * Market policy (pedla_v1.md §1): Under 4.5 axes only, dominant side Under, odds ≥ 1.20.
 */

import { z } from 'zod'
import { buildBookForAdapter } from '@/lib/pedlas/build-book'
import { savePedlasBook } from '@/lib/pedlas/store'
import type { PedlasBook } from '@/lib/pedlas/types'
import { getBook, BOOK_IDS } from '@/lib/books/registry'
import type { BookAdapter } from '@/lib/books/types'

export const runtime = 'nodejs'

const PedlasRequestSchema = z.object({
  /** Bookmakers to build for. Legacy `bookmaker` (single) is also accepted. */
  books:     z.array(z.enum(BOOK_IDS)).min(1).optional(),
  bookmaker: z.enum(BOOK_IDS).optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_from must be YYYY-MM-DD'),
  date_to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_to must be YYYY-MM-DD'),
  budget:    z.number().int().positive().min(10),
  objective: z.enum(['moonshot', 'coverage']).optional(),
  save:      z.boolean().optional(),   // default true; auto-refresh ticks pass false to avoid history spam
  minStake:  z.number().int().positive().optional(),
  maxPayout: z.number().positive().optional(),
  legCount:  z.number().int().min(3).max(18).optional(),
  scanLimit: z.number().int().min(1).max(80).optional(),
  minKickoffGapMinutes: z.number().int().min(0).max(10_080).optional(),
  rank:      z.enum(['nim', 'deterministic', 'auto']).optional(),
  params: z.object({
    minAnchorDistance: z.number().int().min(0).optional(),
    maxPerLeague:      z.number().int().min(1).optional(),
  }).optional(),
}).refine((d) => {
  const from = new Date(d.date_from), to = new Date(d.date_to)
  const maxTo = new Date(from); maxTo.setDate(maxTo.getDate() + 2)
  return to >= from && to <= maxTo
}, { message: 'date_to must be between date_from and date_from + 2 days (near-term fixtures only)' })

type Parsed = z.infer<typeof PedlasRequestSchema>

interface BookResult {
  bookId: string
  label: string
  book?: PedlasBook
  meta?: Record<string, unknown>
  savedId?: string | null
  saved?: boolean
  error?: string
  detail?: string
}

async function buildForBook(adapter: BookAdapter, req: Parsed, budget: number): Promise<BookResult> {
  const base = { bookId: adapter.id, label: adapter.label }
  const built = await buildBookForAdapter(adapter, {
    dateFrom: req.date_from,
    dateTo: req.date_to,
    budget,
    targetLegs: req.legCount ?? 11,
    minStake: req.minStake ?? adapter.minStake,
    maxPayout: req.maxPayout,
    objective: req.objective,
    rank: req.rank,
    scanLimit: req.scanLimit,
    minKickoffGapMinutes: req.minKickoffGapMinutes,
    params: req.params,
  })
  if (!built.book) return { ...base, error: built.error, detail: built.detail }

  let savedId: string | null = null
  if (req.save !== false) {
    savedId = await savePedlasBook({ book: built.book, meta: built.meta ?? {}, dateFrom: req.date_from, dateTo: req.date_to })
  }
  return { ...base, book: built.book, meta: built.meta, savedId, saved: savedId != null }
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = PedlasRequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'Validation failed', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    )
  }

  const req = parsed.data
  const bookIds = req.books ?? (req.bookmaker ? [req.bookmaker] : ['betway_nigeria'])
  const perBookBudget = Math.floor(req.budget / bookIds.length)

  const results: BookResult[] = []
  for (const id of bookIds) {
    results.push(await buildForBook(getBook(id), req, perBookBudget))
  }

  const ok = results.filter(r => r.book)
  const status = ok.length > 0 ? 200 : (results.some(r => /fetch/i.test(r.error ?? '')) ? 503 : 422)

  // Legacy top-level fields mirror the FIRST successful book (single-book callers keep working).
  const first = ok[0]
  return Response.json({
    results,
    booksRequested: bookIds,
    perBookBudget,
    ...(first ? { book: first.book, meta: first.meta, bookId: first.savedId, saved: first.saved } : {}),
    ...(ok.length === 0 ? { error: results[0]?.error ?? 'All books failed', detail: results[0]?.detail } : {}),
  }, { status })
}

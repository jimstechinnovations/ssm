/**
 * GET  /api/pedlas/books — list saved PEDLAS books (newest first) for the history panel.
 * POST /api/pedlas/books — persist an edited book ({ book, meta? }).
 */

import { listPedlasBooks, savePedlasBook } from '@/lib/pedlas/store'
import type { PedlasBook } from '@/lib/pedlas/types'

export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const limitRaw = Number(url.searchParams.get('limit') ?? '30')
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 30
  const books = await listPedlasBooks(limit)
  return Response.json({ books })
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const b = body as { book?: PedlasBook; meta?: Record<string, unknown> }
  if (!b.book || b.book.mode !== 'pedlas' || !Array.isArray(b.book.slips)) {
    return Response.json({ error: 'Body must be { book: PedlasBook, meta? }' }, { status: 400 })
  }
  const bookId = await savePedlasBook({ book: b.book, meta: { ...(b.meta ?? {}), edited: true } })
  return Response.json({ bookId, saved: bookId != null })
}

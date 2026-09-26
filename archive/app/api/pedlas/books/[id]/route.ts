/**
 * GET /api/pedlas/books/:id — fetch one saved book (full PedlasBook + meta) to reload it.
 */

import { z } from 'zod'
import { getPedlasBook } from '@/lib/pedlas/store'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success) {
    return Response.json({ error: 'Invalid book ID' }, { status: 400 })
  }
  const record = await getPedlasBook(id)
  if (!record) return Response.json({ error: 'Book not found' }, { status: 404 })
  return Response.json({ book: record.book, meta: record.meta, results: record.results, id: record.id, createdAt: record.createdAt })
}

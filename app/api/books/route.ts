/**
 * GET /api/books — client-safe metadata for every registered bookmaker adapter
 * (id, label, min stake, caps, feed/boost verification, whether credential env vars are set).
 */

import { listBooks } from '@/lib/books/registry'

export const runtime = 'nodejs'

export async function GET(): Promise<Response> {
  return Response.json({ books: listBooks() })
}

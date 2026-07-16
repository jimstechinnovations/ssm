/**
 * app/api/odds/route.ts
 *
 * Odds fetch handler — validates the `fixture` query param, delegates to
 * fetchFixtureOdds (which owns caching via Supabase odds_cache), and returns
 * the result as JSON.
 *
 * This handler never throws: upstream errors surface as oddsUnavailable=true
 * in the response body, keeping the client experience graceful.
 *
 * Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 6.2, 6.7, 12.4
 */

import { z } from 'zod'
import { fetchFixtureOdds } from '@/lib/football-api/client'

const QuerySchema = z.object({
  fixture: z.coerce.number().int().positive(),
})

// ---------------------------------------------------------------------------
// GET — Fetch odds for a fixture
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)

  const parsed = QuerySchema.safeParse({
    fixture: searchParams.get('fixture'),
  })

  if (!parsed.success) {
    return Response.json(
      { error: 'fixture must be a positive integer' },
      { status: 400 },
    )
  }

  const { fixture: fixtureId } = parsed.data

  const { odds, oddsUnavailable } = await fetchFixtureOdds(fixtureId)

  return Response.json({ odds, oddsUnavailable })
}

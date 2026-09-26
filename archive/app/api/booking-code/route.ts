/**
 * POST /api/booking-code — turn a PEDLA slip's legs into a SportyBet booking code + share URL.
 *
 * This is the reliable placement bridge: the bot builds the slip, this returns a code, and the
 * user opens it in their OWN browser (which is in REAL mode — Playwright sessions are locked to
 * SIM, so the bot cannot place real bets itself) and taps Place Bet.
 */

import { z } from 'zod'
import { sportybetBookingCode } from '@/lib/books/sportybet'

export const runtime = 'nodejs'

const Schema = z.object({
  book: z.literal('sportybet').default('sportybet'),
  legs: z.array(z.object({
    fixtureId: z.number(),
    line: z.number(),
    side: z.enum(['Under', 'Over']),
  })).min(1).max(50),
})

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = Schema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Validation failed', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }, { status: 400 })
  }

  try {
    const { code, url } = await sportybetBookingCode(parsed.data.legs)
    return Response.json({ code, url })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}

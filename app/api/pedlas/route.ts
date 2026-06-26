/**
 * app/api/pedlas/route.ts
 *
 * POST /api/pedlas — PEDLAS total-goals odds builder (small stake → big hit).
 *
 * Flow (stateless — no DB write in v1):
 *   1. Validate body
 *   2. Fetch fixtures for the date range (chosen bookmaker)
 *   3. Scan up to `scanLimit` fixtures: fetch odds → enrich
 *   4. selectAxes() — keep only total-goals Under ≥ 1.20 (Win-Boost qualifying)
 *   5. Order by kickoff, take the target leg count
 *   6. buildPedlasBook() — NIM-central ranking (auto), E/D/A/S, budget K, ₦50M cap
 *   7. Return the PedlasBook + scan meta
 *
 * HONEST: the response is a structured −vig lottery. The route never reports +EV.
 */

import { z } from 'zod'
import { searchFixturesByDateRange, fetchFixtureOdds } from '@/lib/football-api/client'
import { BOOKMAKER_IDS } from '@/lib/ssm/types'
import type { Fixture } from '@/lib/ssm/types'
import { BookmakerPlatformSchema } from '@/lib/ssm/schemas'
import { selectAxes, PEDLAS_LINES } from '@/lib/pedlas/market-select'
import { buildPedlasBook } from '@/lib/pedlas/build'

const PedlasRequestSchema = z.object({
  bookmaker: BookmakerPlatformSchema.default('betway_nigeria'),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_from must be YYYY-MM-DD'),
  date_to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_to must be YYYY-MM-DD'),
  budget:    z.number().int().positive().min(100),
  minStake:  z.number().int().positive().optional(),
  maxPayout: z.number().positive().optional(),
  legCount:  z.number().int().min(3).max(18).optional(),
  scanLimit: z.number().int().min(1).max(80).optional(),
  rank:      z.enum(['nim', 'deterministic', 'auto']).optional(),
  params: z.object({
    minAnchorDistance: z.number().int().min(0).optional(),
    minSlipSeparation: z.number().int().min(1).optional(),
    maxIdenticalRun:   z.number().int().min(1).optional(),
    maxPerLeague:      z.number().int().min(1).optional(),
  }).optional(),
}).refine((d) => {
  const from = new Date(d.date_from), to = new Date(d.date_to)
  const maxTo = new Date(from); maxTo.setDate(maxTo.getDate() + 7)
  return to >= from && to <= maxTo
}, { message: 'date_to must be between date_from and date_from + 7 days' })

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

  const { bookmaker, date_from, date_to, budget } = parsed.data
  const minStake = parsed.data.minStake ?? 100
  const targetLegs = parsed.data.legCount ?? 11
  const scanLimit = parsed.data.scanLimit ?? 30
  const bookmakerId = BOOKMAKER_IDS[bookmaker]

  // Fetch fixtures for the range.
  let allFixtures: Fixture[]
  try {
    allFixtures = await searchFixturesByDateRange(date_from, date_to, bookmakerId)
  } catch {
    return Response.json({ error: 'Failed to fetch fixtures' }, { status: 503 })
  }

  // Scan a bounded number of fixtures for odds, enrich, and collect total-goals axes.
  const enriched: Fixture[] = []
  let scanned = 0
  for (const fx of allFixtures) {
    if (scanned >= scanLimit) break
    scanned++
    try {
      const { odds, oddsUnavailable } = await fetchFixtureOdds(fx.id, bookmakerId)
      if (oddsUnavailable || odds.length === 0) continue
      enriched.push({ ...fx, odds })
    } catch {
      continue
    }
  }

  // PEDLAS market policy → axes, ordered by kickoff, trimmed to the target leg count.
  const axesAll = selectAxes(enriched).sort((a, b) => a.kickoff.localeCompare(b.kickoff))
  const axes = axesAll.slice(0, targetLegs)

  if (axes.length < 3) {
    return Response.json({
      error: 'Not enough qualifying total-goals markets',
      detail: `Found ${axesAll.length} fixture(s) with an Under ≥ 1.20 total-goals line (need ≥ 3). ` +
        `Scanned ${scanned} fixture(s). Try a wider date range or a different bookmaker.`,
      lines: PEDLAS_LINES,
    }, { status: 422 })
  }

  try {
    const book = await buildPedlasBook({
      axes,
      budget,
      minStake,
      maxPayout: parsed.data.maxPayout,
      params: parsed.data.params,
      rank: parsed.data.rank ?? 'auto',
    })
    return Response.json({
      book,
      meta: { scanned, fixturesFound: allFixtures.length, qualifyingAxes: axesAll.length, usedAxes: axes.length },
    })
  } catch (err) {
    return Response.json(
      { error: 'PEDLAS build failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

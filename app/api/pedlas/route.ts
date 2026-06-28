/**
 * POST /api/pedlas
 *
 * PEDLAS total-goals odds builder. Betway Nigeria uses the public Betway feed
 * through Playwright; other bookmakers keep the API-Football fallback.
 */

import { z } from 'zod'
import { searchFixturesByDateRange, fetchFixtureOdds } from '@/lib/football-api/client'
import { BOOKMAKER_IDS } from '@/lib/ssm/types'
import type { Fixture } from '@/lib/ssm/types'
import { BookmakerPlatformSchema } from '@/lib/ssm/schemas'
import { selectAxes, PEDLAS_LINES } from '@/lib/pedlas/market-select'
import { buildPedlasBook } from '@/lib/pedlas/build'
import { savePedlasBook } from '@/lib/pedlas/store'
import { enrichAxes, advisoryCoverage } from '@/lib/pedlas/enrich'
import { selectByQuality } from '@/lib/pedlas/quality'
import { DEFAULT_PARAMS } from '@/lib/pedlas/types'
import { fetchBetwayPedlasFixtures } from '@/lib/betway/playwright'

export const runtime = 'nodejs'

const PedlasRequestSchema = z.object({
  bookmaker: BookmakerPlatformSchema.default('betway_nigeria'),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_from must be YYYY-MM-DD'),
  date_to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_to must be YYYY-MM-DD'),
  budget:    z.number().int().positive().min(100),
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
    minSlipSeparation: z.number().int().min(1).optional(),
    maxIdenticalRun:   z.number().int().min(1).optional(),
    maxPerLeague:      z.number().int().min(1).optional(),
  }).optional(),
}).refine((d) => {
  const from = new Date(d.date_from), to = new Date(d.date_to)
  const maxTo = new Date(from); maxTo.setDate(maxTo.getDate() + 7)
  return to >= from && to <= maxTo
}, { message: 'date_to must be between date_from and date_from + 7 days' })

async function apiFootballFixtures(
  dateFrom: string,
  dateTo: string,
  bookmakerId: number | null,
  scanLimit: number,
): Promise<{ allFixtures: Fixture[]; enriched: Fixture[]; scanned: number }> {
  const allFixtures = await searchFixturesByDateRange(dateFrom, dateTo, bookmakerId)
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

  return { allFixtures, enriched, scanned }
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

  const { bookmaker, date_from, date_to, budget } = parsed.data
  const minStake = parsed.data.minStake ?? 100
  const targetLegs = parsed.data.legCount ?? 11
  const scanLimit = parsed.data.scanLimit ?? 30
  const minKickoffGapMinutes = parsed.data.minKickoffGapMinutes ?? 60
  const bookmakerId = BOOKMAKER_IDS[bookmaker]

  let allFixtures: Fixture[]
  let enriched: Fixture[]
  let scanned: number
  const sourceMeta: Record<string, unknown> = {}

  if (bookmaker === 'betway_nigeria') {
    try {
      const betway = await fetchBetwayPedlasFixtures({
        dateFrom: date_from,
        dateTo: date_to,
        scanLimit,
        minKickoffGapMinutes,
      })
      allFixtures = betway.fixtures
      enriched = betway.fixtures
      scanned = betway.fixtures.length
      sourceMeta.oddsSource = betway.source
      sourceMeta.feedUrl = betway.feedUrl
      sourceMeta.minKickoffGapMinutes = minKickoffGapMinutes
    } catch (err) {
      return Response.json({
        error: 'Failed to fetch Betway public odds with Playwright',
        detail: err instanceof Error ? err.message : String(err),
      }, { status: 503 })
    }
  } else {
    try {
      const result = await apiFootballFixtures(date_from, date_to, bookmakerId, scanLimit)
      allFixtures = result.allFixtures
      enriched = result.enriched
      scanned = result.scanned
      sourceMeta.oddsSource = 'api-football'
    } catch {
      return Response.json({ error: 'Failed to fetch fixtures' }, { status: 503 })
    }
  }

  const axesAll = selectAxes(enriched)
  const maxPerLeague = parsed.data.params?.maxPerLeague ?? DEFAULT_PARAMS.maxPerLeague

  if (axesAll.length < 3) {
    return Response.json({
      error: 'Not enough qualifying total-goals markets',
      detail: `Found ${axesAll.length} fixture(s) with an Under >= 1.20 total-goals line (need >= 3). ` +
        `Scanned ${scanned} fixture(s). PEDLAS only uses ${PEDLAS_LINES.join(', ')} lines, ` +
        `max ${maxPerLeague} legs per league, and kickoff gap >= ${minKickoffGapMinutes} minutes.`,
      lines: PEDLAS_LINES,
      source: sourceMeta,
    }, { status: 422 })
  }

  // Shortlist the most book-confident fixtures (bounds enrichment cost), enrich them with team-history
  // leans (store-first, so usually no live calls), then pick the BEST legs by composite quality
  // (confidence − vig − volatility ± form). Each chosen axis carries its decision rationale.
  const shortlist = [...axesAll]
    .sort((a, b) => Math.max(b.underProb, b.overProb) - Math.max(a.underProb, a.overProb))
    .slice(0, targetLegs * 2 + 6)
  const enrichedShort = await enrichAxes(shortlist)
  const axes = selectByQuality(enrichedShort, targetLegs, maxPerLeague)

  try {
    const book = await buildPedlasBook({
      axes,
      budget,
      objective: parsed.data.objective ?? 'moonshot',
      minStake,
      maxPayout: parsed.data.maxPayout,
      params: parsed.data.params,
      rank: parsed.data.rank ?? 'auto',
    })
    const meta = {
      scanned,
      fixturesFound: allFixtures.length,
      qualifyingAxes: axesAll.length,
      usedAxes: axes.length,
      advisory: advisoryCoverage(axes),
      ...sourceMeta,
    }

    // Persist (default on). Soft-fails if the migration isn't applied yet.
    let bookId: string | null = null
    if (parsed.data.save !== false) {
      bookId = await savePedlasBook({ book, meta, dateFrom: date_from, dateTo: date_to })
    }

    return Response.json({ book, meta, bookId, saved: bookId != null })
  } catch (err) {
    return Response.json(
      { error: 'PEDLAS build failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

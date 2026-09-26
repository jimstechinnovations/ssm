/**
 * /api/placement — the placement bot.
 *   POST { action:'start', bookId, slips, dryRun? }  → create + start a paced run (dryRun default TRUE)
 *   POST { action:'stop', runId }                    → kill switch
 *   GET  ?runId=…                                    → one run's status
 *   GET                                              → all runs (newest first)
 *
 * Live placement requires ALL of: PLACEMENT_LIVE=1 env, dryRun:false, the book enabled in
 * /config, and a verified live-placement implementation for that book.
 */

import { z } from 'zod'
import type { PedlasSlip } from '@/lib/pedlas/types'
import { startRun, stopRun, getRun, listRuns, isLivePlacementAllowed } from '@/lib/placement/queue'
import { getBookConfig, toPlacementConfig } from '@/lib/books/config-store'
import { savePlacement } from '@/lib/placement/store'
import { placeBetwaySlipLive } from '@/lib/placement/place-betway'
import { placeSportybetSlipLive } from '@/lib/placement/place-sportybet'
import { getBook } from '@/lib/books/registry'

export const runtime = 'nodejs'

const LegSchema = z.object({
  fixtureId: z.number(), game: z.string(), league: z.string(), kickoff: z.string(),
  line: z.number(), side: z.enum(['Under', 'Over']), market: z.string(), outcome: z.string(),
  odds: z.number(),
})
const SlipSchema = z.object({
  slipId: z.number(), vector: z.array(z.union([z.literal(0), z.literal(1)])),
  legs: z.array(LegSchema).min(1), legCount: z.number(), combinedOdds: z.number(),
  trueProb: z.number(), boostPct: z.number(), stake: z.number().positive(),
  payout: z.number(), uncappedPayout: z.number(), capped: z.boolean(),
  evMultiple: z.number(), rankScore: z.number(),
  reasoning: z.string().optional(), hiddenRisk: z.string().optional(),
})
const StartSchema = z.object({
  action: z.literal('start'),
  bookId: z.string(),
  slips: z.array(SlipSchema).min(1).max(500),
  dryRun: z.boolean().default(true),
  /** Links each placement row back to the saved PEDLA book it came from. */
  pedlasBookId: z.string().uuid().nullish(),
})
const StopSchema = z.object({ action: z.literal('stop'), runId: z.string() })
const BodySchema = z.discriminatedUnion('action', [StartSchema, StopSchema])

const LIVE_PLACERS: Record<string, typeof placeSportybetSlipLive> = {
  betway_nigeria: placeBetwaySlipLive,
  sportybet: placeSportybetSlipLive,
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'Validation failed', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    )
  }

  if (parsed.data.action === 'stop') {
    const ok = stopRun(parsed.data.runId)
    return ok ? Response.json({ stopped: true }) : Response.json({ error: 'Unknown runId' }, { status: 404 })
  }

  const { bookId, slips, dryRun, pedlasBookId } = parsed.data
  try {
    getBook(bookId) // validate the id against the registry
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }

  const cfg = toPlacementConfig(await getBookConfig(bookId))
  if (!dryRun) {
    if (!isLivePlacementAllowed()) {
      return Response.json({ error: 'Live placement is locked — set PLACEMENT_LIVE=1 to enable (pedla_v1.md §4).' }, { status: 403 })
    }
    if (!cfg.enabled) {
      return Response.json({ error: `Live placement for "${bookId}" is disabled in /config.` }, { status: 403 })
    }
  }

  try {
    const run = startRun({
      bookId,
      slips: slips as PedlasSlip[],
      dryRun,
      config: cfg,
      placeLive: LIVE_PLACERS[bookId],
      // Every finished job goes to the ledger — including failures, with the reason.
      onJobDone: (job, slip) => savePlacement({
        runId: run.runId, bookId, pedlasBookId: pedlasBookId ?? null, dryRun, job, slip,
      }).then(() => undefined),
    })
    return Response.json({ runId: run.runId, status: run.status, dryRun: run.dryRun, jobs: run.jobs.length })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}

export async function GET(request: Request): Promise<Response> {
  const runId = new URL(request.url).searchParams.get('runId')
  if (runId) {
    const run = getRun(runId)
    return run ? Response.json({ run }) : Response.json({ error: 'Unknown runId' }, { status: 404 })
  }
  return Response.json({ runs: listRuns() })
}

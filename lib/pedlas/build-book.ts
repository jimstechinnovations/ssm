// lib/pedlas/build-book.ts
// One place that turns a bookmaker adapter + build options into a PEDLA book (fetch odds → select
// Under-4.5 axes → advisory enrich → quality-pick legs → buildPedlasBook). Shared by the /api/pedlas
// builder and the /api/sessions builder so both use the exact same pipeline. No persistence here.

import 'server-only'
import type { BookAdapter } from '../books/types'
import type { Fixture, PedlasBook, PedlasParams } from './types'
import { DEFAULT_PARAMS } from './types'
import { selectAxes, PEDLA_LINES, MIN_DOMINANT_ODDS } from './market-select'
import { enrichAxes, advisoryCoverage } from './enrich'
import { selectByQuality } from './quality'
import { buildPedlasBook } from './build'
import { buildCoverageBook, type CoverageBook } from './coverage'
import type { PedlasSlip } from './types'

export interface BuildBookOptions {
  dateFrom: string
  dateTo: string
  budget: number
  targetLegs: number
  minStake: number
  maxPayout?: number
  objective?: 'moonshot' | 'coverage'
  rank?: 'nim' | 'deterministic' | 'auto'
  scanLimit?: number
  minKickoffGapMinutes?: number
  params?: Partial<Pick<PedlasParams, 'minAnchorDistance' | 'maxPerLeague'>>
}

export interface BuildBookResult {
  book?: PedlasBook
  meta?: Record<string, unknown>
  error?: string
  detail?: string
}

/** Build one PEDLA book for one adapter. Returns { book, meta } or { error, detail } — never throws. */
export async function buildBookForAdapter(adapter: BookAdapter, opts: BuildBookOptions): Promise<BuildBookResult> {
  const minStake = Math.max(opts.minStake, adapter.minStake)
  const targetLegs = Math.max(3, opts.targetLegs)
  const scanLimit = opts.scanLimit ?? Math.max(30, targetLegs * 2 + 10)
  const minKickoffGapMinutes = opts.minKickoffGapMinutes ?? 60
  const maxPerLeague = opts.params?.maxPerLeague ?? DEFAULT_PARAMS.maxPerLeague

  if (opts.budget < minStake) {
    return { error: `Budget share ₦${opts.budget} is below ${adapter.label}'s minimum stake ₦${minStake}` }
  }

  let fixtures: Fixture[]
  const sourceMeta: Record<string, unknown> = {}
  try {
    const feed = await adapter.fetchFixtures({ dateFrom: opts.dateFrom, dateTo: opts.dateTo, scanLimit, minKickoffGapMinutes })
    fixtures = feed.fixtures
    sourceMeta.oddsSource = feed.source
    sourceMeta.feedUrl = feed.feedUrl
    sourceMeta.minKickoffGapMinutes = minKickoffGapMinutes
  } catch (err) {
    return { error: `Failed to fetch ${adapter.label} odds`, detail: err instanceof Error ? err.message : String(err) }
  }

  const axesAll = selectAxes(fixtures, { lines: PEDLA_LINES, requireDominantSide: 'Under' })
  if (axesAll.length < 3) {
    return {
      error: 'Not enough qualifying Under 4.5 markets',
      detail: `Found ${axesAll.length} fixture(s) with Under 4.5 dominant at odds ≥ ${MIN_DOMINANT_ODDS} ` +
        `(need ≥ 3) among ${fixtures.length} scanned.`,
    }
  }

  const shortlist = [...axesAll]
    .sort((a, b) => Math.max(b.underProb, b.overProb) - Math.max(a.underProb, a.overProb))
    .slice(0, targetLegs * 2 + 6)
  const enrichedShort = await enrichAxes(shortlist)
  const axes = selectByQuality(enrichedShort, targetLegs, maxPerLeague)

  try {
    const book = await buildPedlasBook({
      axes,
      budget: opts.budget,
      objective: opts.objective ?? 'moonshot',
      minStake,
      maxPayout: Math.min(opts.maxPayout ?? adapter.maxPayout, adapter.maxPayout),
      params: opts.params,
      rank: opts.rank ?? 'auto',
      boostFor: adapter.boostFor,
      bookId: adapter.id,
    })
    const meta = {
      scanned: fixtures.length,
      fixturesFound: fixtures.length,
      qualifyingAxes: axesAll.length,
      usedAxes: axes.length,
      advisory: advisoryCoverage(axes),
      boostVerified: adapter.boostVerified,
      ...sourceMeta,
    }
    return { book, meta }
  } catch (err) {
    return { error: 'PEDLA build failed', detail: err instanceof Error ? err.message : String(err) }
  }
}

export interface CoverageAdapterOptions {
  dateFrom: string
  dateTo: string
  budget: number
  stake: number
  targetWin?: number
  legPref?: number
  maxPayout?: number
  scanLimit?: number
  minKickoffGapMinutes: number    // the configurable selection window (30–60 min)
  /** Verified boost table override (book_configs.boost_json). Falls back to the adapter's boost. */
  boost?: import('./boost').BoostFn
}

export interface CoverageResult {
  book?: CoverageBook
  meta?: Record<string, unknown>
  slips?: PedlasSlip[]
  error?: string
  detail?: string
}

/**
 * Build a coverage book for one adapter: fetch the WHOLE qualifying Under-4.5 pool inside the
 * selection window, enrich it with history (parallel, advisory), then scatter K = budget/stake slips
 * at the requested leg-count. Returns the slips + honest hit-chance. Never throws.
 */
export async function buildCoverageForAdapter(adapter: BookAdapter, opts: CoverageAdapterOptions): Promise<CoverageResult> {
  const stake = Math.max(opts.stake, adapter.minStake)
  const scanLimit = opts.scanLimit ?? 80   // grab a big pool so slips can scatter

  let fixtures: Fixture[]
  const sourceMeta: Record<string, unknown> = {}
  try {
    const feed = await adapter.fetchFixtures({ dateFrom: opts.dateFrom, dateTo: opts.dateTo, scanLimit, minKickoffGapMinutes: opts.minKickoffGapMinutes })
    fixtures = feed.fixtures
    sourceMeta.oddsSource = feed.source
    sourceMeta.feedUrl = feed.feedUrl
    sourceMeta.selectionWindowMin = opts.minKickoffGapMinutes
  } catch (err) {
    return { error: `Failed to fetch ${adapter.label} odds`, detail: err instanceof Error ? err.message : String(err) }
  }

  const axesAll = selectAxes(fixtures, { lines: PEDLA_LINES, requireDominantSide: 'Under' })
  if (axesAll.length < 4) {
    return { error: 'Not enough qualifying Under 4.5 games', detail: `Found ${axesAll.length} (need ≥4) among ${fixtures.length} scanned in the window.` }
  }

  // History + advisory (parallel inside enrichAxes) — required per the operator, advisory to the math.
  const enriched = await enrichAxes(axesAll)

  const book = buildCoverageBook(enriched, {
    budget: opts.budget, stake, maxPayout: Math.min(opts.maxPayout ?? adapter.maxPayout, adapter.maxPayout),
    boost: opts.boost ?? adapter.boostFor, legPref: opts.legPref, targetWin: opts.targetWin,
  })
  const meta = {
    scanned: fixtures.length,
    qualifyingAxes: axesAll.length,
    poolSize: book.poolSize,
    legs: book.L,
    slips: book.K,
    pAnyWin: book.pAnyWin,
    medianPayout: book.medianPayout,
    medianOdds: book.medianOdds,
    meanCutters: book.meanCutters,
    beta: book.beta,
    note: book.note,
    advisory: advisoryCoverage(enriched),
    ...sourceMeta,
  }
  return { book, slips: book.slips, meta }
}

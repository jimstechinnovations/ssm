// lib/pedlas/build-book.ts
// One place that turns a bookmaker adapter + build options into a PEDLA book (fetch odds → select
// Under-4.5 axes → advisory enrich → quality-pick legs → buildPedlasBook). Shared by the /api/pedlas
// builder and the /api/sessions builder so both use the exact same pipeline. No persistence here.

import 'server-only'
import type { BookAdapter } from '../books/types'
import type { Fixture, PedlasBook, PedlasParams } from './types'
import { DEFAULT_PARAMS } from './types'
import { selectAxes, PEDLA_LINES, PEDLAS_LINES, MIN_DOMINANT_ODDS } from './market-select'
import { enrichAxes, enrichSignals, advisoryCoverage } from './enrich'
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
  /** Only build on games we have history for (falls back to all + a note if too few exist yet). */
  requireHistory?: boolean
  /** Flip-eligible if P(Over) ≥ this. Higher ⇒ lock more safe games ⇒ deeper covering guarantee. */
  overThreshold?: number
  /** If set, SCATTER flips across depths up to this fraction of eligible legs (instead of layered). */
  maxFlipFrac?: number
  /** Scatter mode: reject slips with ≥ this many consecutive Overs (default 3). */
  maxRun?: number
  /** Use the correlated SIMULATION engine (realizer, optimum-plan §10) instead of the scatter. */
  realizer?: boolean
  /** Realizer: blend history p̂ into the coverage marginal (0=book-only default, 1=history). The honest
   *  P(win) is always book-measured, so >0 only helps IF history beats the book (backtest: it doesn't). */
  signalWeight?: number
  /** Anchor market policy. 'under_4.5' (default) = Under-4.5 anchors only. 'multi_line' = per game pick
   *  the most reliable dominant anchor across all total lines (Over 1.5 for goals-games, Under 3.5, …). */
  marketPolicy?: 'under_4.5' | 'multi_line'
  /** Drop games whose league matches any of these substrings (e.g. ["friendl"]) — the cutter leagues. */
  excludeLeagues?: string[]
}

export interface CoverageResult {
  book?: CoverageBook
  meta?: Record<string, unknown>
  slips?: PedlasSlip[]
  usedDateTo?: string
  error?: string
  detail?: string
}

/** Whole days from a→b (both YYYY-MM-DD, UTC); ≥0. */
function daysBetween(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5))
}

/**
 * Build a coverage book for one adapter: fetch the WHOLE qualifying Under-4.5 pool inside the
 * selection window, enrich it with history (parallel, advisory), then scatter K = budget/stake slips
 * at the requested leg-count. Returns the slips + honest hit-chance. Never throws.
 */
export async function buildCoverageForAdapter(adapter: BookAdapter, opts: CoverageAdapterOptions): Promise<CoverageResult> {
  const stake = Math.max(opts.stake, adapter.minStake)
  const scanLimit = opts.scanLimit ?? 250  // grab a big pool so slips can scatter (bigger for exclude-league builds)
  const boost = opts.boost ?? adapter.boostFor
  const target = opts.targetWin ?? stake * 1000

  // Legs needed to reach the target on the day's median Under odds (with real boost) — the pool must
  // hold at least this many qualifying games or the base parlay can't reach ₦target.
  const legsNeeded = (medOdds: number) => { let l = 3; for (; l <= 90; l++) if (stake * Math.pow(Math.max(1.05, medOdds), l) * (1 + boost(l)) >= target) return l; return 90 }

  // AUTO-EXTEND the window +1 day at a time until the pool can reach the target (nothing hardcoded).
  let axesAll: ReturnType<typeof selectAxes> = []
  let fixtures: Fixture[] = []
  let usedDateTo = opts.dateTo
  const sourceMeta: Record<string, unknown> = {}
  for (let extra = 0; extra <= 30; extra++) {   // keep adding days until the pool can reach the target
    const dt = new Date(`${opts.dateFrom}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() + Math.max(0, daysBetween(opts.dateFrom, opts.dateTo)) + extra)
    usedDateTo = dt.toISOString().slice(0, 10)
    try {
      const feed = await adapter.fetchFixtures({ dateFrom: opts.dateFrom, dateTo: usedDateTo, scanLimit, minKickoffGapMinutes: opts.minKickoffGapMinutes })
      fixtures = feed.fixtures
      sourceMeta.oddsSource = feed.source; sourceMeta.feedUrl = feed.feedUrl; sourceMeta.selectionWindowMin = opts.minKickoffGapMinutes
    } catch (err) {
      return { error: `Failed to fetch ${adapter.label} odds`, detail: err instanceof Error ? err.message : String(err) }
    }
    // Anchor policy: Under-4.5 only (default), or multi-line best-anchor per game (Over 1.5 / Under 3.5 /
    // Under 4.5 / … — the most reliable dominant side across all total lines). Both are −vig.
    axesAll = opts.marketPolicy === 'multi_line'
      ? selectAxes(fixtures, { lines: PEDLAS_LINES })
      : selectAxes(fixtures, { lines: PEDLA_LINES, requireDominantSide: 'Under' })
    // League exclusion (learnings 2026-07-18): friendlies go Over ~26–43% (the cutters) vs ~17% in
    // real competitions. Drop excluded leagues before selection so the pool is competitive-only.
    if (opts.excludeLeagues?.length) {
      const rx = new RegExp(opts.excludeLeagues.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
      axesAll = axesAll.filter(a => !rx.test(a.league))
    }
    if (axesAll.length >= 4) {
      const medOdds = [...axesAll.map(a => a.underOdds)].sort((x, y) => x - y)[Math.floor(axesAll.length / 2)]
      if (axesAll.length >= legsNeeded(medOdds)) break   // enough games to reach target
    }
  }
  sourceMeta.usedDateTo = usedDateTo
  if (axesAll.length < 4) {
    return { error: 'Not enough qualifying Under 4.5 games', detail: `Found ${axesAll.length} (need ≥4) even after extending to ${usedDateTo}.` }
  }

  // COMBINED-SIGNAL advisory (parallel): form (both teams' recent scoring) is the history backbone,
  // with H2H as a bonus and the book line as the anchor. A game is "history-informed" iff it has form
  // on BOTH teams — achievable, because form is per-team and reusable across fixtures.
  const enriched = await enrichSignals(axesAll)
  const withHistory = enriched.filter(a => a.advisory?.hasForm)
  const medOdds = [...enriched.map(a => a.underOdds)].sort((x, y) => x - y)[Math.floor(enriched.length / 2)]
  const needed = legsNeeded(medOdds)

  // GATE: when requireHistory, use ONLY the form-backed games if enough exist. If not enough yet
  // (teams not synced into the corpus), fall back to all + say so (never silently blind).
  let pool = enriched
  let gateNote = ''
  if (opts.requireHistory) {
    if (withHistory.length >= needed) pool = withHistory
    else gateNote = `Only ${withHistory.length}/${enriched.length} games are history-informed (need ~${needed}). Placed on ALL games — sync more teams' form to gate properly.`
  } else if (withHistory.length >= needed) {
    // not required, but if we have enough with history, prefer them (cleaner selection)
    pool = withHistory
  }

  const book = buildCoverageBook(pool, {
    budget: opts.budget, stake, maxPayout: Math.min(opts.maxPayout ?? adapter.maxPayout, adapter.maxPayout),
    boost: opts.boost ?? adapter.boostFor, legPref: opts.legPref, targetWin: opts.targetWin,
    overThreshold: opts.overThreshold, maxFlipFrac: opts.maxFlipFrac, maxRun: opts.maxRun, realizer: opts.realizer,
    signalWeight: opts.signalWeight,
  })
  const meta = {
    scanned: fixtures.length,
    qualifyingAxes: axesAll.length,
    withHistory: withHistory.length,
    poolSize: book.poolSize,
    legs: book.L,
    slips: book.K,
    pAnyWin: book.pAnyWin,
    medianPayout: book.medianPayout,
    medianOdds: book.medianOdds,
    meanCutters: book.meanCutters,
    beta: book.beta,
    // covering-design guarantee (layered flip coverage over the signal-eligible set)
    eligibleCount: book.eligibleCount,
    completeDepth: book.completeDepth,
    partialDepth: book.partialDepth,
    partialCovered: book.partialCovered,
    lockedCount: book.lockedCount,
    // build-time survival-curve exposure (realizer): where the pool is most exposed BEFORE placing.
    cutRisk: book.cutRisk ? {
      worst: book.cutRisk.worstByRisk,
      maxSingleCutFrac: book.cutRisk.maxSingleCutFrac,
      expectedFinalAlive: book.cutRisk.expectedFinalAlive,
      top: [...book.cutRisk.games].sort((a, b) => b.riskWeight - a.riskWeight).slice(0, 6),
    } : null,
    note: [book.note, gateNote].filter(Boolean).join(' '),
    advisory: advisoryCoverage(pool),
    ...sourceMeta,
  }
  return { book, slips: book.slips, meta, usedDateTo }
}

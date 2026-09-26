// lib/pedlas/build-book.ts
// Turns a bookmaker adapter + session options into a coverage book: fetch odds → select axes →
// history signals (gate) → multi-market coverage (default) or the legacy Under-4.5 scatter/realizer.
// Used by /api/sessions. No persistence here. (The older PEDLAS-book builder lives in archive/.)

import 'server-only'
import type { BookAdapter } from '../books/types'
import type { Fixture } from './types'
import { selectAxes, PEDLA_LINES, PEDLAS_LINES } from './market-select'
import { enrichSignals, advisoryCoverage } from './enrich'
import { buildCoverageBook, type CoverageBook } from './coverage'
import { buildMultiAxes, buildMultiBook, toPedlasSlips } from './multi-market'
import type { PedlasSlip } from './types'

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
  /** Cap the auto-extend: never select games more than this many days past date_from (default 30). Set
   *  to 1 or 2 to keep the whole session inside one/two days so it settles fast. */
  maxWindowDays?: number
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

  // AUTO-EXTEND the window +1 day at a time until the pool can reach the target — but never past
  // maxWindowDays from date_from (so "keep it to 1–2 days" is honoured; default 30). Fewer games in a
  // tight window just means shorter slips, which the sampled-mix/boost handle fine.
  let axesAll: ReturnType<typeof selectAxes> = []
  let fixtures: Fixture[] = []
  let usedDateTo = opts.dateTo
  const sourceMeta: Record<string, unknown> = {}
  const maxExtra = Math.max(0, (opts.maxWindowDays ?? 30) - daysBetween(opts.dateFrom, opts.dateTo))
  for (let extra = 0; extra <= 30; extra++) {   // hard max 30; prefer to stop within maxExtra (see below)
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
      if (axesAll.length >= legsNeeded(medOdds)) break   // reached target — stop (tight window)
      if (extra >= maxExtra) break                        // hit the preferred window with a buildable pool
      // — accept the shorter book (sampled-mix + boost handle fewer games); don't over-extend.
    }
    // else (<4 games): keep extending PAST the preferred window — the dead-end auto-adjust.
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

  // Window honesty: say so whenever the build reached past what was asked for (the dead-end auto-adjust
  // can go beyond max_window_days when the window has < 4 games) — the session then settles later.
  const windowDays = daysBetween(opts.dateFrom, usedDateTo)
  const windowNote = usedDateTo > opts.dateTo
    ? `Window extended to ${usedDateTo} (${windowDays}d from ${opts.dateFrom})${windowDays > (opts.maxWindowDays ?? 30) ? ` — PAST the ${opts.maxWindowDays}-day cap because the window had too few games` : ''}; the session settles later.`
    : ''
  sourceMeta.windowDays = windowDays
  if (windowNote) sourceMeta.windowWarning = windowNote

  // GATE: when requireHistory, use ONLY the form-backed games. Not enough → REFUSE with the numbers
  // (h2h-informed-is-default: never silently fall back to history-blind slips).
  let pool = enriched
  const gateNote = ''
  if (opts.requireHistory) {
    if (withHistory.length >= needed) pool = withHistory
    else return {
      error: 'Not enough history-informed games',
      detail: `Only ${withHistory.length}/${enriched.length} games have form for both teams; ~${needed} are needed to reach ₦${target.toLocaleString()}. ` +
        `Sync history for this window (Sofascore, needs the debug Chrome), lower the target, or widen the dates — then rebuild.`,
      meta: { withHistory: withHistory.length, qualifying: enriched.length, needed, ...sourceMeta },
    }
  } else if (withHistory.length >= needed) {
    // not required, but if we have enough with history, prefer them (cleaner selection)
    pool = withHistory
  }

  const capPay = Math.min(opts.maxPayout ?? adapter.maxPayout, adapter.maxPayout)
  const boostFn = opts.boost ?? adapter.boostFor

  // ── DEFAULT: multi-market 3-band coverage (Under 2.5 / Under 4.5 / Over 2.5) + variable-leg trimming ──
  // Each game is LOW(0-2)/MID(3-4)/HIGH(5+); slips mix the markets, MID is the free overlap, legs are
  // trimmed to fit the target. Keep-rate is computed HONESTLY under book independence (still −vig). The
  // legacy Under-4.5/Over-4.5 realizer is reachable with market_policy:'under_4.5'.
  if (opts.marketPolicy !== 'under_4.5') {
    // Build ONLY from the gated pool (history-informed when required) — the multi-market path used to
    // re-read every fixture here, silently ignoring require_history.
    const poolIds = new Set(pool.map(a => a.fixtureId))
    const mAxes = buildMultiAxes(fixtures).filter(a => poolIds.has(a.fixtureId))
    if (mAxes.length >= 6) {
      const mm = buildMultiBook(mAxes, { budget: opts.budget, stake, target, maxPayout: capPay, boost: boostFn })
      if (mm.slips.length === 0) {
        return { error: 'No slip can reach the target', detail: `Even the full ${mm.N}-game combo on these ${mAxes.length} games pays < ₦${target.toLocaleString()}. Lower the target or widen the window.` }
      }
      const slips = toPedlasSlips(mm, mAxes, stake, capPay, boostFn)
      const legCounts = slips.map(s => s.legCount)
      const meta = {
        scanned: fixtures.length, qualifyingAxes: mAxes.length, withHistory: withHistory.length, historyGated: Boolean(opts.requireHistory),
        poolSize: mAxes.length, legs: mm.N, slips: slips.length, pAnyWin: mm.pAnyWin, pAnyWinCorrelated: mm.pAnyWinCorrelated, rhoStress: mm.rhoStress,
        medianPayout: mm.medianPayout, keepRate: mm.keepRate, expectedNet: mm.expectedNet,
        marketBasis: 'multi (U2.5/U4.5/O2.5/O4.5)', variableLegs: { min: Math.min(...legCounts), max: Math.max(...legCounts) },
        note: [mm.note, gateNote, windowNote, `HONEST keep ${mm.keepRate.toFixed(3)} (<1 = −vig); coverage real, vig untouched.`].filter(Boolean).join(' '),
        ...sourceMeta,
      }
      const bookShim = { L: mm.N, K: slips.length, poolSize: mAxes.length, pAnyWin: mm.pAnyWin, medianPayout: mm.medianPayout, medianOdds: 0, slips, note: mm.note } as unknown as CoverageBook
      return { book: bookShim, slips, meta, usedDateTo }
    }
  }

  const book = buildCoverageBook(pool, {
    budget: opts.budget, stake, maxPayout: capPay,
    boost: boostFn, legPref: opts.legPref, targetWin: opts.targetWin,
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
    note: [book.note, gateNote, windowNote].filter(Boolean).join(' '),
    advisory: advisoryCoverage(pool),
    ...sourceMeta,
  }
  return { book, slips: book.slips, meta, usedDateTo }
}

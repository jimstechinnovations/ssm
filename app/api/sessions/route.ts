/**
 * /api/sessions — the Bet-Manager session (pedlas_v3.md §1–3).
 *   POST { books[], date_from, date_to, budget, target_win, min_stake? }
 *        → build a PEDLA book per book, persist the session + its slips, return the session.
 *   GET  → list recent sessions (with a slip scoreboard each).
 *
 * Phase 2: sizing reuses the current quality builder (legs derived roughly from the target). The
 * covering-design engine that turns budget into guaranteed cutter-depth lands in Phase 3 and will
 * only change HOW slips are chosen — the session/persistence contract here stays the same.
 */

import { z } from 'zod'
import { getBook, BOOK_IDS } from '@/lib/books/registry'
import { getBookConfig } from '@/lib/books/config-store'
import { buildCoverageForAdapter } from '@/lib/pedlas/build-book'
import { buildDecisionBotForAdapter } from '@/lib/pedlas/build-bot'
import { boostFromTable } from '@/lib/pedlas/boost'
import { fetchSportyBonusPlan, sportyBoostFn } from '@/lib/books/sportybet-bonus'
import { estimatePlacement } from '@/lib/pedlas/coverage'
import { ledgerSummary } from '@/lib/placement/store'
import { createSession, updateSession, saveSessionSlips, listSessions, sessionSummary, scoreboards } from '@/lib/sessions/store'

export const runtime = 'nodejs'

const CreateSchema = z.object({
  books:      z.array(z.enum(BOOK_IDS)).min(1),
  date_from:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  budget:     z.number().positive().min(10),
  target_win: z.number().positive().min(100),
  min_stake:  z.number().positive().optional(),
  /** Legs per slip (the ~30–33 regime). If unset, derived from target_win. */
  leg_pref:   z.number().int().min(3).max(60).optional(),
  /** Selection window: only pick games kicking off ≥ this many minutes out, so none go live during
   *  the placement run. 30–60 min recommended. */
  selection_window_min: z.number().int().min(15).max(600).optional(),
  /** Only build on games we have real history for (falls back with a note until Sofascore lands). */
  require_history: z.boolean().optional(),
  /** Flip-eligible if P(Over) ≥ this. Higher ⇒ lock more safe games ⇒ deeper covering guarantee. */
  over_threshold: z.number().min(0).max(0.9).optional(),
  /** If set, SCATTER flips across depths up to this fraction of eligible legs (e.g. 0.5). */
  max_flip_frac: z.number().min(0).max(1).optional(),
  /** Scatter mode: reject slips with ≥ this many consecutive Overs (default 3). */
  max_run: z.number().int().min(2).max(10).optional(),
  /** Use the correlated SIMULATION engine (realizer, optimum-plan §10). */
  realizer: z.boolean().optional(),
  /** Realizer: blend history p̂ into the coverage marginal (0=book default, 1=history). >0 lowers the
   *  book-honest P(win) unless history beats the book — which it doesn't (pedlas-no-model-edge). */
  signal_weight: z.number().min(0).max(1).optional(),
  /** Anchor market policy: 'under_4.5' (default) or 'multi_line' (best dominant anchor per game across
   *  all total lines — Over 1.5 for goals-games, Under 3.5, Under 4.5, …). Both −vig. */
  market_policy: z.enum(['under_4.5', 'multi_line']).optional(),
  /** Cap the selection window to this many days from date_from (e.g. 1 or 2) so the whole session
   *  settles within a day or two. Default 30 (auto-extend as needed). */
  max_window_days: z.number().int().min(1).max(30).optional(),
  /** Drop games whose league matches any of these substrings (e.g. ["friendl"] to skip friendlies). */
  exclude_leagues: z.array(z.string()).optional(),
  /** Which builder: the Decision Bot (default), the multi-market coverage engine, or the legacy Under-4.5 engine. */
  engine: z.enum(['decision_bot', 'multi_market', 'under_4.5']).optional(),
  /** Decision Bot: payout band above the target, in % (default 1 → every slip pays ₦T–₦1.01T). */
  band_pct: z.number().min(0.1).max(25).optional(),
  /** Decision Bot: how picks are made (default greedy — max P(≥1 win) with fingerprint-disjoint slips). */
  rule: z.enum(['greedy', 'weighted', 'random', 'flip']).optional(),
  /** Decision Bot: allow legs under 1.20 odds (they don't count toward SportyBet's bonus). Default true. */
  allow_sub_min_legs: z.boolean().optional(),
  /** Decision Bot: seed — same seed + same odds ⇒ same slips and same decision log. Default: time-based. */
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  /** Decision Bot: let a slip skip games instead of using every game in order — fewer, higher-odds legs
   *  (lower combined margin) at a fixed target, raising keep and so P(>=1 win). Needs max_legs. Default off. */
  skip: z.boolean().optional(),
  /** Decision Bot: share of the budget (0–0.5) spent on FLOOR tickets — SportyBet Flexi "k of 8" on likely,
   *  low-margin legs, so a day with no jackpot still returns part of the budget. Default 0 (off). */
  floor_share: z.number().min(0).max(0.5).optional(),
  /** Decision Bot: rate legs against the reference panel (Pinnacle + Kambi). Default true. */
  use_panel: z.boolean().optional(),
  /** Decision Bot: cap on legs per slip. Required for `skip` (otherwise a slip could use all ~80 games). */
  max_legs: z.number().int().min(2).max(40).optional(),
}).refine(d => {
  const from = new Date(d.date_from), to = new Date(d.date_to)
  const maxTo = new Date(from); maxTo.setDate(maxTo.getDate() + 2)
  return to >= from && to <= maxTo
}, { message: 'date_to must be between date_from and date_from + 2 days' })

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = CreateSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Validation failed', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }, { status: 400 })
  }
  const req = parsed.data

  // Effective min stake = max(requested, every selected book's configured min) so no slip underflows.
  const cfgs = await Promise.all(req.books.map(getBookConfig))
  const minStake = Math.max(req.min_stake ?? 0, ...cfgs.map(c => c.minStake))
  const perBookBudget = Math.floor(req.budget / req.books.length)
  // Selection window is COMPUTED from how long placing all the slips takes (run = slips × ~20s), so
  // no game kicks off mid-run. ~500 slips ⇒ ~2.8h run ⇒ ~5h window. Override with selection_window_min.
  const slipEstimate = Math.floor(req.budget / minStake)
  const placement = estimatePlacement(slipEstimate)
  const windowMin = req.selection_window_min ?? placement.windowMinutes

  const session = await createSession({
    bookIds: req.books, dateFrom: req.date_from, dateTo: req.date_to,
    budget: req.budget, targetWin: req.target_win, minStake,
  })
  if (!session) return Response.json({ error: 'Could not create session (is migration 006 applied?)' }, { status: 500 })

  const bookResults: Array<{ bookId: string; slips?: number; legs?: number; pAnyWin?: number; medianPayout?: number; withHistory?: number; keepRate?: number; expectedNet?: number; legRange?: { min: number; max: number }; windowWarning?: string; note?: string; error?: string; detail?: string }> = []
  const bookMetas: Record<string, unknown> = {}
  let totalSlips = 0
  let repL: number | undefined
  let repPool: number | undefined
  let repPAny: number | undefined
  let usedDateTo = req.date_to   // may auto-extend if the window lacks enough games

  const cfgById = new Map(req.books.map((id, i) => [id, cfgs[i]]))
  const engine = req.engine ?? 'decision_bot'
  const seed = req.seed ?? (Date.now() % 1_000_000_007)   // stored with the session, so the build is reproducible
  for (const id of req.books) {
    const cfg = cfgById.get(id)
    // SportyBet: the LIVE bonus plan (the site changes it — the stored table went stale on 2026-09-09).
    // Other books: the verified stored table, else the adapter default.
    let boost = cfg?.boost ? boostFromTable(cfg.boost) : undefined
    if (id === 'sportybet') { try { boost = sportyBoostFn(await fetchSportyBonusPlan()) } catch { /* keep the stored/adapter table */ } }
    const requireHistory = req.require_history ?? true                 // history-informed is the default (never silently blind)

    if (engine === 'decision_bot') {
      const bot = await buildDecisionBotForAdapter(getBook(id), {
        dateFrom: req.date_from, dateTo: req.date_to, budget: perBookBudget, stake: minStake, target: req.target_win,
        minKickoffGapMinutes: windowMin, band: (req.band_pct ?? 1) / 100, rule: req.rule ?? 'greedy',
        allowSubMinLegs: req.allow_sub_min_legs ?? true, seed, requireHistory, excludeLeagues: req.exclude_leagues, boost,
        // The build no longer blocks the server (runDecisionBotAsync yields between steps), so it can take
        // the time a full budget needs: on 2026-10-01 a 180 s cap split one ₦2,000 budget into six
        // mini-sessions (each stopped at 30–79 slips). 15 min is a safety net, not a pacing tool; a build
        // cut short still returns its slips and says so in the note.
        skip: req.skip, maxLegs: req.max_legs, deadlineMs: 15 * 60_000,
        floorShare: req.floor_share, usePanel: req.use_panel,
      })
      if (!bot.slips || !bot.result) { bookResults.push({ bookId: id, error: bot.error, detail: bot.detail }); continue }
      const saved = await saveSessionSlips(session.id, id, bot.slips)
      totalSlips += saved
      const m = bot.meta as { variableLegs: { min: number; max: number }; gamesUsed: number; poolSize: number; withHistory: number; note: string }
      repL ??= m.gamesUsed; repPool ??= m.poolSize; repPAny ??= bot.result.pAnyWin
      bookMetas[id] = bot.meta
      bookResults.push({ bookId: id, slips: saved, legs: m.gamesUsed, pAnyWin: bot.result.pAnyWin, withHistory: m.withHistory, keepRate: bot.result.keepRate, expectedNet: bot.result.expectedNet, legRange: m.variableLegs, note: m.note })
      continue
    }

    const built = await buildCoverageForAdapter(getBook(id), {
      dateFrom: req.date_from, dateTo: req.date_to, budget: perBookBudget, stake: minStake,
      targetWin: req.target_win, legPref: req.leg_pref, minKickoffGapMinutes: windowMin, boost, requireHistory,
      overThreshold: req.over_threshold, maxFlipFrac: req.max_flip_frac, maxRun: req.max_run, realizer: req.realizer,
      signalWeight: req.signal_weight, marketPolicy: engine === 'under_4.5' ? 'under_4.5' : req.market_policy,
      maxWindowDays: req.max_window_days, excludeLeagues: req.exclude_leagues,
    })
    if (!built.book || !built.slips) { bookResults.push({ bookId: id, error: built.error, detail: built.detail }); continue }
    if (built.usedDateTo && built.usedDateTo > usedDateTo) usedDateTo = built.usedDateTo
    const saved = await saveSessionSlips(session.id, id, built.slips)
    totalSlips += saved
    repL ??= built.book.L; repPool ??= built.book.poolSize; repPAny ??= built.book.pAnyWin
    bookMetas[id] = built.meta
    const m = (built.meta ?? {}) as { withHistory?: number; keepRate?: number; expectedNet?: number; variableLegs?: { min: number; max: number }; windowWarning?: string; note?: string }
    bookResults.push({ bookId: id, slips: saved, legs: built.book.L, pAnyWin: built.book.pAnyWin, medianPayout: built.book.medianPayout, withHistory: m.withHistory, keepRate: m.keepRate, expectedNet: m.expectedNet, legRange: m.variableLegs, windowWarning: m.windowWarning, note: String(m.note ?? built.book.note ?? '') })
  }

  const ok = totalSlips > 0
  await updateSession(session.id, {
    status: ok ? 'placing' : 'failed',
    dateTo: usedDateTo,
    legCount: repL,
    slipCount: totalSlips,
    poolSize: repPool,
    meta: { engine, seed, perBookBudget, windowMin, usedDateTo, placement, pAnyWin: repPAny, books: bookResults, bookMetas },
  })

  return Response.json({
    session: { ...session, status: ok ? 'placing' : 'failed', dateTo: usedDateTo, legCount: repL, slipCount: totalSlips, poolSize: repPool },
    books: bookResults,
    placement: { ...placement, windowMin },   // est. run + selection window used
    summary: await sessionSummary(session.id),
  }, { status: ok ? 200 : 422 })
}

export async function GET(): Promise<Response> {
  const sessions = await listSessions()
  const [sb, totals] = await Promise.all([scoreboards(sessions.map(s => ({ id: s.id, slipCount: s.slipCount }))), ledgerSummary()])
  // totals cover EVERY real slip (not just the listed sessions) — the same numbers the Results page shows
  return Response.json({ sessions: sessions.map(s => ({ ...s, summary: sb[s.id] })), totals })
}

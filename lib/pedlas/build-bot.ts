// lib/pedlas/build-bot.ts
// Session builder for the Decision Bot: fetch every two-sided selection per game from the book, apply
// the HISTORY gate (only games where both teams have recent form — h2h-informed-is-default), attach each
// game's past meetings (cited in the decision log), run the bot, and turn its slips into stored legs that
// carry the exact booking-code ids, the settlement rule and the reason for every pick. No persistence.

import 'server-only'
import type { BookAdapter } from '../books/types'
import type { BoostFn } from './boost'
import type { PedlasLeg, PedlasSlip } from './types'
import { runDecisionBot, type BotGame, type BotRule, type BotResult } from './decision-bot'
import { orderGames } from './selections'
import { getTeamRecent, getH2H } from './history-store'
import { formFromMatchResults } from '../football-history/apifootball'
import { fetchSportyBonusPlan, sportyBonus, type SportyBonusPlan } from '../books/sportybet-bonus'
import type { Selection } from './selections'

export interface BotBuildOptions {
  dateFrom: string
  dateTo: string
  budget: number
  stake: number
  target: number
  minKickoffGapMinutes: number
  band?: number                 // 0.01 = 1%
  rule?: BotRule
  allowSubMinLegs?: boolean
  seed?: number
  requireHistory?: boolean      // default true
  excludeLeagues?: string[]
  boost?: BoostFn
  maxPayout?: number
  skip?: boolean                // let a slip skip games (fewer, higher-odds legs) — needs maxLegs
  maxLegs?: number
  deadlineMs?: number           // wall-clock build budget — see BotConfig.deadlineMs (never hangs the server)
}

/** A stored slip plus the bot's slip-level decision (persisted to pedla_placements.decision). */
export type BotPedlasSlip = PedlasSlip & { decision: Record<string, unknown> }

export interface BotBuildResult {
  slips?: BotPedlasSlip[]
  result?: BotResult
  meta?: Record<string, unknown>
  error?: string
  detail?: string
}

export async function buildDecisionBotForAdapter(adapter: BookAdapter, o: BotBuildOptions): Promise<BotBuildResult> {
  if (!adapter.fetchSelectionGames) return { error: `${adapter.label} doesn't expose the markets the Decision Bot needs`, detail: 'Use SportyBet, or the multi-market engine.' }
  const stake = Math.max(o.stake, adapter.minStake)
  let games
  try { games = (await adapter.fetchSelectionGames({ dateFrom: o.dateFrom, dateTo: o.dateTo, scanLimit: 400, minKickoffGapMinutes: o.minKickoffGapMinutes })).games }
  catch (e) { return { error: `Failed to fetch ${adapter.label} odds`, detail: e instanceof Error ? e.message : String(e) } }
  if (o.excludeLeagues?.length) {
    const rx = new RegExp(o.excludeLeagues.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
    games = games.filter(g => !rx.test(g.league))
  }
  // History for the games in order (a slip only ever uses the first games, so look at the first 120).
  const ordered = orderGames(games).slice(0, 120)
  const withHist: BotGame[] = await Promise.all(ordered.map(async (g): Promise<BotGame> => {
    const [hr, ar, h2h] = await Promise.all([getTeamRecent(g.home, g.kickoff, 14), getTeamRecent(g.away, g.kickoff, 14), getH2H(g.home, g.away, g.kickoff, 12)])
    const hasForm = hr.length >= 3 && ar.length >= 3
    const fh = hasForm ? formFromMatchResults(hr, g.home) : null, fa = hasForm ? formFromMatchResults(ar, g.away) : null
    return {
      ...g,
      history: {
        hasForm,
        formNote: fh && fa ? `form: ${g.home} scores ~${fh.attack.toFixed(1)}, ${g.away} ~${fa.attack.toFixed(1)} per game` : undefined,
        // orient every past meeting to THIS fixture's home/away so rules like "Home win" read correctly
        h2h: h2h.map(m => m.home === g.home ? { h: m.hg, a: m.ag } : { h: m.ag, a: m.hg }),
      },
    }
  }))
  const requireHistory = o.requireHistory ?? true
  const pool = requireHistory ? withHist.filter(g => g.history?.hasForm) : withHist
  if (pool.length < 3) {
    return {
      error: 'Not enough history-informed games',
      detail: `Only ${withHist.filter(g => g.history?.hasForm).length} of ${withHist.length} games have recent form for both teams. Sync history (Games tab → Sync history, needs the debug Chrome) or widen the dates, then rebuild.`,
    }
  }

  // SportyBet: price every slip with the site's OWN bonus formula from its live plan, so the built payout
  // is what the betslip will show. (If the plan can't be read, fall back to the leg-count table.)
  let plan: SportyBonusPlan | null = null
  if (adapter.id === 'sportybet') { try { plan = await fetchSportyBonusPlan() } catch { plan = null } }
  const tournamentOf = new Map(pool.flatMap(g => g.selections.map(sel => [sel, g.tournamentId] as const)))
  const bonusFn = plan ? (sels: Selection[]) => sportyBonus(sels.map(x => ({ odds: x.odds, probability: x.probability, margin: x.margin, tournamentId: tournamentOf.get(x) })), plan!).perStake : undefined

  const result = runDecisionBot(pool, {
    stake, target: o.target, budget: o.budget, band: o.band, rule: o.rule, allowSubMinLegs: o.allowSubMinLegs,
    seed: o.seed, boost: o.boost ?? adapter.boostFor, bonusFn, maxPayout: Math.min(o.maxPayout ?? adapter.maxPayout, adapter.maxPayout),
    skip: o.skip, maxLegs: o.maxLegs, deadlineMs: o.deadlineMs,
  })
  if (result.slips.length === 0) return { error: 'No slip can reach the target band', detail: result.notes.join(' ') || 'Lower the target or widen the window.' }

  const slips: BotPedlasSlip[] = result.slips.map(s => {
    const legs: PedlasLeg[] = s.legs.map(l => {
      const g = result.games[l.game], sel = l.selection
      const total = sel.rule.kind === 'total' ? sel.rule : null
      return {
        fixtureId: g.fixtureId, game: g.game, league: g.league, kickoff: g.kickoff,
        // line/side only mean something for total-goals legs; every consumer reads `rule` first
        line: total?.line ?? 0, side: total?.side ?? 'Under',
        market: `SB_${sel.marketId}${sel.specifier ? `_${sel.specifier}` : ''}`, outcome: sel.name, odds: sel.odds,
        rule: sel.rule, marketId: sel.marketId, specifier: sel.specifier, outcomeId: sel.outcomeId, why: l.why, p: l.p,
      }
    })
    const uncapped = stake * s.combinedOdds * (1 + s.bonus)
    return {
      slipId: s.slipId, vector: [], legs, legCount: legs.length, combinedOdds: s.combinedOdds, trueProb: s.pWin,
      boostPct: s.bonus * 100, stake, payout: s.payout, uncappedPayout: uncapped, capped: uncapped > s.payout,
      evMultiple: s.keep, rankScore: 0,
      decision: { engine: 'decision_bot', rule: result.config.rule, seed: result.config.seed, why: s.why, pWin: s.pWin, keep: s.keep, bonusApplies: s.bonusApplies, band: result.config.band },
    }
  })
  const legCounts = slips.map(s => s.legCount)
  const meta = {
    engine: 'decision_bot',
    bot: { rule: result.config.rule, band: result.config.band, allowSubMinLegs: result.config.allowSubMinLegs, seed: result.config.seed, minLegOdds: result.config.minLegOdds, skip: result.config.skip, maxLegs: result.config.maxLegs },
    scanned: games.length, withHistory: withHist.filter(g => g.history?.hasForm).length, historyGated: requireHistory, poolSize: pool.length,
    gamesUsed: Math.max(...legCounts), slips: slips.length, pAnyWin: result.pAnyWin, ceiling: result.ceiling,
    keepRate: result.keepRate, expectedNet: result.expectedNet, variableLegs: { min: Math.min(...legCounts), max: Math.max(...legCounts) },
    bonusSlips: result.slips.filter(s => s.bonusApplies).length, calibrationMaxError: result.calibrationMaxError,
    order: result.games.slice(0, Math.max(...legCounts)).map(g => g.game),
    bonusPlan: plan ? plan.planName : 'fallback leg-count table (live plan unavailable)',
    note: [`Decision Bot (${result.config.rule}, band ${(100 * result.config.band).toFixed(1)}%, seed ${result.config.seed}${result.config.skip ? `, skip on, maxLegs ${result.config.maxLegs}` : ''})`, plan ? `bonus priced with SportyBet's live plan ${plan.planName}` : 'bonus from the fallback table', ...result.notes].join(' · '),
  }
  return { slips, result, meta }
}

// lib/pedlas/build-bot.ts
// Session builder for the Decision Bot: fetch every two-sided selection per game from the book, attach
// each game's recent form and past meetings (cited in the decision log — never a filter, see below), run
// the bot without blocking the server, and turn its slips into stored legs that carry the exact
// booking-code ids, the settlement rule and the reason for every pick. No persistence.

import 'server-only'
import type { BookAdapter } from '../books/types'
import type { BoostFn } from './boost'
import type { PedlasLeg, PedlasSlip } from './types'
import { runDecisionBotAsync, type BotGame, type BotRule, type BotResult } from './decision-bot'
import { orderGames } from './selections'
import { getTeamRecent, getH2H } from './history-store'
import { formFromMatchResults } from '../football-history/apifootball'
import { fetchSportyBonusPlan, sportyBonus, type SportyBonusPlan } from '../books/sportybet-bonus'
import type { Selection, SelectionGame } from './selections'
import { buildFloor } from './floor'
import { loadPanel } from '../books/panel'
import { consensus } from '../books/reference'

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
  /** @deprecated No longer gates the pool — every scanned game is usable, with history cited where it
   *  exists. Kept only so old callers don't break; accepted but ignored. */
  requireHistory?: boolean
  excludeLeagues?: string[]
  boost?: BoostFn
  maxPayout?: number
  skip?: boolean                // let a slip skip games (fewer, higher-odds legs) — needs maxLegs
  maxLegs?: number
  deadlineMs?: number           // wall-clock build budget — see BotConfig.deadlineMs (never hangs the server)
  /** Share of the budget (0–0.5) spent on FLOOR tickets — Flexi "k of 8" on likely, low-margin legs that
   *  return part of the budget on a day with no jackpot (lib/pedlas/floor.ts, docs/near-miss-design.md). */
  floorShare?: number
  /** Attach the reference panel's prices (Pinnacle + Kambi) to every pick. Default true; a source that
   *  can't be reached is simply left out. */
  usePanel?: boolean
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
  const tDiag0 = Date.now(); const tDiag = (label: string) => console.log(`[build-bot] ${label}: ${((Date.now() - tDiag0) / 1000).toFixed(1)}s`)
  let games
  try { games = (await adapter.fetchSelectionGames({ dateFrom: o.dateFrom, dateTo: o.dateTo, scanLimit: 400, minKickoffGapMinutes: o.minKickoffGapMinutes })).games }
  catch (e) { return { error: `Failed to fetch ${adapter.label} odds`, detail: e instanceof Error ? e.message : String(e) } }
  tDiag(`fetchSelectionGames (${games.length} games)`)
  // The reference panel: each pick gets the consensus of Pinnacle + Kambi where they price it. The bot
  // rates a leg at that consensus when both sources agree (BotConfig.legProb 'panel'), else at SportyBet's
  // own fair price. Never blocks a build: if the panel can't load, every pick keeps the book's price.
  let panelNote = 'reference panel off'
  if (o.usePanel !== false) {
    try {
      const panel = await loadPanel(games)
      let priced = 0
      for (const g of games) for (const s of g.selections) { const c = consensus(panel.games.get(g.fixtureId), s.rule); if (c) { s.sharp = c; priced++ } }
      panelNote = `reference panel: ${panel.sources.map(x => `${x.source} matched ${x.matched}/${games.length}`).join(', ')} · ${priced} picks priced${panel.errors.length ? ` · ${panel.errors.join('; ')}` : ''}`
    } catch (e) { panelNote = `reference panel unavailable (${e instanceof Error ? e.message : e}) — book prices used` }
    tDiag(panelNote)
  }
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
  tDiag(`history fetch (${ordered.length} games)`)
  // History is DATA attached to each game (cited in every pick's reason, still gates nothing in the odds
  // themselves — the live book price is always the honest probability), not a hard filter that can shrink
  // the whole board to a handful of games. Found live 2026-10-01: requiring hasForm dropped 103 games to
  // 7, and when Sofascore then rate-limited us (403), there was no way to recover more games at all - the
  // wrong failure mode to have as kickoffs approach and odds move. The full pool is always usable; a game
  // either carries real history (cited) or doesn't (noted as such) — `requireHistory` no longer excludes.
  const pool = withHist
  const withHistoryCount = withHist.filter(g => g.history?.hasForm).length
  tDiag(`history: ${withHistoryCount}/${withHist.length} games carry real form (pool stays at ${pool.length})`)
  if (pool.length < 3) {
    return {
      error: 'Not enough games',
      detail: `Only ${withHist.length} games were found for this window. Widen the dates, then rebuild.`,
    }
  }

  // SportyBet: price every slip with the site's OWN bonus formula from its live plan, so the built payout
  // is what the betslip will show. (If the plan can't be read, fall back to the leg-count table.)
  let plan: SportyBonusPlan | null = null
  if (adapter.id === 'sportybet') { try { plan = await fetchSportyBonusPlan() } catch { plan = null } }
  tDiag('bonus plan fetched')
  const tournamentOf = new Map(pool.flatMap(g => g.selections.map(sel => [sel, g.tournamentId] as const)))
  const bonusFn = plan ? (sels: Selection[]) => sportyBonus(sels.map(x => ({ odds: x.odds, probability: x.probability, margin: x.margin, tournamentId: tournamentOf.get(x) })), plan!).perStake : undefined

  const floorShare = Math.min(0.5, Math.max(0, o.floorShare ?? 0))
  const jackpotBudget = Math.round(o.budget * (1 - floorShare))
  const result = await runDecisionBotAsync(pool, {   // non-blocking: the server keeps answering while it builds
    stake, target: o.target, budget: jackpotBudget, band: o.band, rule: o.rule, allowSubMinLegs: o.allowSubMinLegs,
    seed: o.seed, boost: o.boost ?? adapter.boostFor, bonusFn, maxPayout: Math.min(o.maxPayout ?? adapter.maxPayout, adapter.maxPayout),
    skip: o.skip, maxLegs: o.maxLegs, deadlineMs: o.deadlineMs,
  })
  tDiag(`runDecisionBot (${result.slips.length} slips)`)
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
  // ── the FLOOR layer: Flexi tickets on likely, low-margin legs, away from the jackpot slips' games ──
  let floorMeta: Record<string, unknown> | undefined
  if (floorShare > 0) {
    const jackpotGames = new Set(result.slips.flatMap(s => s.legs.map(l => result.games[l.game].fixtureId)))
    const panelP = (_g: SelectionGame, s: Selection) => s.sharp && s.sharp.n >= 2 && s.sharp.spread <= 0.04 ? s.sharp.p : s.probability
    // floor tickets at the book's MINIMUM stake (₦10), whatever the jackpot stake: more, smaller tickets
    // spread the floor over more games, so the money back is steadier
    const floorStake = adapter.minStake
    const fl = buildFloor(pool, { budget: o.budget - jackpotBudget, stake: floorStake, avoidFixtures: jackpotGames, probOf: panelP })
    let id = slips.length
    for (const t of fl.tickets) {
      const legs: PedlasLeg[] = t.legs.map(l => {
        const total = l.sel.rule.kind === 'total' ? l.sel.rule : null
        return {
          fixtureId: l.game.fixtureId, game: l.game.game, league: l.game.league, kickoff: l.game.kickoff,
          line: total?.line ?? 0, side: total?.side ?? 'Under',
          market: `SB_${l.sel.marketId}${l.sel.specifier ? `_${l.sel.specifier}` : ''}`, outcome: l.sel.name, odds: l.sel.odds,
          rule: l.sel.rule, marketId: l.sel.marketId, specifier: l.sel.specifier, outcomeId: l.sel.outcomeId, p: l.p,
          why: `floor leg: ${l.sel.name} @${l.sel.odds} · P ${(100 * l.p).toFixed(1)}%, keeps ${(l.p * l.sel.odds).toFixed(3)}${l.sel.sharp ? ` · panel ${Object.entries(l.sel.sharp.by).map(([k, v]) => `${k} ${(100 * v).toFixed(1)}%`).join(', ')}` : ''}`,
        }
      })
      slips.push({
        slipId: ++id, vector: [], legs, legCount: legs.length, combinedOdds: t.odds, trueProb: t.pWin,
        boostPct: 0, stake: floorStake, payout: t.payout, uncappedPayout: t.payout, capped: false, evMultiple: t.key, rankScore: 0,
        decision: { engine: 'floor', product: 'flexi', k: t.k, n: t.n, flexiOdds: t.odds, key: t.key, pWin: t.pWin, why: t.why },
      })
    }
    const avg = (f: (t: typeof fl.tickets[number]) => number) => fl.tickets.length ? fl.tickets.reduce((x, t) => x + f(t), 0) / fl.tickets.length : 0
    floorMeta = { share: floorShare, budget: o.budget - jackpotBudget, tickets: fl.tickets.length, avgKey: avg(t => t.key), avgPayout: avg(t => t.payout), avgWinChance: avg(t => t.pWin), notes: fl.notes }
  }
  const legCounts = slips.map(s => s.legCount)
  const meta = {
    engine: 'decision_bot',
    bot: { rule: result.config.rule, band: result.config.band, allowSubMinLegs: result.config.allowSubMinLegs, seed: result.config.seed, minLegOdds: result.config.minLegOdds, skip: result.config.skip, maxLegs: result.config.maxLegs },
    scanned: games.length, withHistory: withHistoryCount, historyGated: false, poolSize: pool.length,
    gamesUsed: Math.max(...legCounts), slips: slips.length, pAnyWin: result.pAnyWin, ceiling: result.ceiling,
    keepRate: result.keepRate, expectedNet: result.expectedNet, variableLegs: { min: Math.min(...legCounts), max: Math.max(...legCounts) },
    bonusSlips: result.slips.filter(s => s.bonusApplies).length, calibrationMaxError: result.calibrationMaxError,
    order: result.games.slice(0, Math.max(...legCounts)).map(g => g.game),
    bonusPlan: plan ? plan.planName : 'fallback leg-count table (live plan unavailable)',
    floor: floorMeta, panel: panelNote,
    note: [`Decision Bot (${result.config.rule}, band ${(100 * result.config.band).toFixed(1)}%, seed ${result.config.seed}${result.config.skip ? `, skip on, maxLegs ${result.config.maxLegs}` : ''})`, plan ? `bonus priced with SportyBet's live plan ${plan.planName}` : 'bonus from the fallback table', panelNote, ...(floorMeta ? [`floor: ${floorMeta.tickets} Flexi tickets (${Math.round(100 * floorShare)}% of the budget), each returns ≈ ₦${(floorMeta.avgKey as number).toFixed(2)} per ₦1`] : []), ...result.notes].join(' · '),
  }
  return { slips, result, meta }
}

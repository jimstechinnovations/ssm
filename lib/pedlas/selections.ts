// lib/pedlas/selections.ts
// The Decision Bot's selection catalogue (algorithm_v1.md §4.2–4.3).
//
// Every selection is a RULE on the final scoreline (home, away): it wins on exactly the scorelines the
// rule accepts. Selections come in two-sided PAIRS — a selection and its FLIP win on complementary
// scorelines, so "flip" is always well defined. The same rule is used to price (scoreline table),
// to explain (decision log) and to settle (final score), so all three can never disagree.

export type LegRule =
  | { kind: 'total'; line: number; side: 'Over' | 'Under' }
  | { kind: 'team_total'; team: 'home' | 'away'; line: number; side: 'Over' | 'Under' }
  | { kind: '1x2'; pick: 'H' | 'D' | 'A' }
  | { kind: 'dc'; pick: 'HD' | 'HA' | 'DA' }
  | { kind: 'btts'; yes: boolean }
  | { kind: 'odd_even'; odd: boolean }
  | { kind: 'clean_sheet'; team: 'home' | 'away'; yes: boolean }

/** Does this rule win on final score home–away? */
export function ruleWins(r: LegRule, h: number, a: number): boolean {
  switch (r.kind) {
    case 'total': return r.side === 'Over' ? h + a > r.line : h + a < r.line
    case 'team_total': { const g = r.team === 'home' ? h : a; return r.side === 'Over' ? g > r.line : g < r.line }
    case '1x2': return r.pick === 'H' ? h > a : r.pick === 'A' ? a > h : h === a
    case 'dc': return r.pick === 'HD' ? h >= a : r.pick === 'DA' ? a >= h : h !== a
    case 'btts': return (h > 0 && a > 0) === r.yes
    case 'odd_even': return ((h + a) % 2 === 1) === r.odd
    case 'clean_sheet': return ((r.team === 'home' ? a : h) === 0) === r.yes
  }
}

/** True if the rule can be judged from the TOTAL alone (legacy results only carried the total). */
export const needsOnlyTotal = (r: LegRule) => r.kind === 'total' || r.kind === 'odd_even'

/** A leg's rule: explicit (Decision Bot legs) or derived from the legacy Over/Under line + side. */
export function legRuleOf(leg: { rule?: LegRule; line?: number; side?: string }): LegRule | null {
  if (leg.rule) return leg.rule
  if (leg.line != null && (leg.side === 'Over' || leg.side === 'Under')) return { kind: 'total', line: leg.line, side: leg.side }
  return null
}

export interface Selection {
  key: string            // stable id within a game, e.g. "18|total=2.5|12"
  name: string           // human label, e.g. "Over 2.5", "Home win", "Both score: No"
  marketId: string       // SportyBet market id (booking codes)
  specifier: string      // SportyBet specifier ('' if none)
  outcomeId: string      // SportyBet outcome id (booking codes)
  odds: number
  rule: LegRule
  flipKey: string        // key of the complementary selection
  margin: number         // the pair's overround (1/a + 1/b − 1)
  probability?: number   // SportyBet's own (margin-free) outcome probability — used by its bonus formula
}

export interface SelectionGame {
  fixtureId: number
  home: string
  away: string
  game: string           // "Home vs Away"
  league: string
  kickoff: string        // ISO
  tournamentId?: string  // e.g. "sr:tournament:17" (the bonus factor can be set per tournament)
  selections: Selection[]
}

// ── SportyBet feed → pairs ──────────────────────────────────────────────────────
export interface SbOutcome { id?: string; desc?: string; odds?: string; probability?: string; isActive?: number }
export interface SbMarket { id?: string; specifier?: string; status?: number; outcomes?: SbOutcome[] }

/** Markets the catalogue reads (ids as SportyBet uses them). */
export const SELECTION_MARKET_IDS = ['1', '10', '18', '19', '20', '26', '29', '31', '32']

const HALF_LINES = new Set([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5])

/** Build every two-sided pair available for one event. Inactive/suspended outcomes are skipped. */
export function selectionsFromMarkets(markets: SbMarket[]): Selection[] {
  const live = markets.filter(m => m.status === undefined || m.status === 0)
  const mk = (id: string, spec?: string) => live.find(m => m.id === id && (spec === undefined || (m.specifier ?? '') === spec))
  const out = (m: SbMarket | undefined, desc: RegExp) => m?.outcomes?.find(o => o.isActive !== 0 && desc.test(o.desc ?? ''))
  const pairs: Selection[] = []
  const add = (
    ma: SbMarket | undefined, oa: SbOutcome | undefined, na: string, ra: LegRule,
    mb: SbMarket | undefined, ob: SbOutcome | undefined, nb: string, rb: LegRule,
  ) => {
    const a = Number(oa?.odds), b = Number(ob?.odds)
    if (!ma || !mb || !oa?.id || !ob?.id || !(a > 1) || !(b > 1)) return
    const ka = `${ma.id}|${ma.specifier ?? ''}|${oa.id}`, kb = `${mb.id}|${mb.specifier ?? ''}|${ob.id}`
    const margin = 1 / a + 1 / b - 1
    const prob = (o: SbOutcome) => { const v = Number(o.probability); return v > 0 && v < 1 ? v : undefined }
    pairs.push({ key: ka, name: na, marketId: ma.id!, specifier: ma.specifier ?? '', outcomeId: oa.id, odds: a, rule: ra, flipKey: kb, margin, probability: prob(oa) })
    pairs.push({ key: kb, name: nb, marketId: mb.id!, specifier: mb.specifier ?? '', outcomeId: ob.id, odds: b, rule: rb, flipKey: ka, margin, probability: prob(ob) })
  }
  // 1X2 ↔ Double Chance (the flip of a 3-way pick is the other two outcomes)
  const x = mk('1'), dc = mk('10')
  add(x, out(x, /^home$/i), 'Home win', { kind: '1x2', pick: 'H' }, dc, out(dc, /draw or away/i), 'Draw or Away', { kind: 'dc', pick: 'DA' })
  add(x, out(x, /^away$/i), 'Away win', { kind: '1x2', pick: 'A' }, dc, out(dc, /home or draw/i), 'Home or Draw', { kind: 'dc', pick: 'HD' })
  add(x, out(x, /^draw$/i), 'Draw', { kind: '1x2', pick: 'D' }, dc, out(dc, /home or away/i), 'Home or Away', { kind: 'dc', pick: 'HA' })
  // totals (half lines only — whole lines can refund)
  for (const m of live.filter(m => m.id === '18')) {
    const L = Number(/total=([\d.]+)/.exec(m.specifier ?? '')?.[1]); if (!HALF_LINES.has(L)) continue
    add(m, out(m, /^over/i), `Over ${L}`, { kind: 'total', line: L, side: 'Over' }, m, out(m, /^under/i), `Under ${L}`, { kind: 'total', line: L, side: 'Under' })
  }
  // team totals
  for (const [id, team] of [['19', 'home'], ['20', 'away']] as const) for (const m of live.filter(m => m.id === id)) {
    const L = Number(/total=([\d.]+)/.exec(m.specifier ?? '')?.[1]); if (!HALF_LINES.has(L)) continue
    const T = team === 'home' ? 'Home' : 'Away'
    add(m, out(m, /^over/i), `${T} over ${L}`, { kind: 'team_total', team, line: L, side: 'Over' }, m, out(m, /^under/i), `${T} under ${L}`, { kind: 'team_total', team, line: L, side: 'Under' })
  }
  const gg = mk('29'); add(gg, out(gg, /^yes$/i), 'Both score: Yes', { kind: 'btts', yes: true }, gg, out(gg, /^no$/i), 'Both score: No', { kind: 'btts', yes: false })
  const oe = mk('26'); add(oe, out(oe, /^odd$/i), 'Total goals odd', { kind: 'odd_even', odd: true }, oe, out(oe, /^even$/i), 'Total goals even', { kind: 'odd_even', odd: false })
  for (const [id, team] of [['31', 'home'], ['32', 'away']] as const) {
    const m = mk(id); const T = team === 'home' ? 'Home' : 'Away'
    add(m, out(m, /^yes$/i), `${T} clean sheet: Yes`, { kind: 'clean_sheet', team, yes: true }, m, out(m, /^no$/i), `${T} clean sheet: No`, { kind: 'clean_sheet', team, yes: false })
  }
  return pairs
}

/** Deterministic game order used everywhere (algorithm_v1 §4.1): kickoff → shortest "Home vs Away" → A→Z. */
export function orderGames<T extends { kickoff: string; game: string }>(games: T[]): T[] {
  return [...games].sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.game.length - b.game.length || a.game.localeCompare(b.game))
}

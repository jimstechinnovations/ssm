// lib/books/reference.ts
// A PANEL of outside bookmakers' prices used as the reference for what a result is really worth.
// One source can be wrong on a game (stale line, wrong fixture pairing); several independent books
// agreeing is much stronger evidence. Each source turns its board into fair (de-vigged) probabilities;
// the panel matches every SportyBet fixture to each source, drops pairings that are clearly wrong, and
// returns a weighted consensus per pick plus how much the sources disagree.
//
// Sources (lib/books/pinnacle.ts, lib/books/kambi.ts): Pinnacle — the sharpest (weight 2); Kambi — the
// trading platform behind Unibet / 888sport / LeoVegas / BetMGM (weight 1). Both read-only public feeds.
//
// Measured 2026-10-02 (scripts/sharp-probe.ts): SportyBet's own outcome probability equals Pinnacle's
// (median ratio 1.000 over 2,992 picks) and its odds sit ~7% under that fair price (median odds × P =
// 0.933). Picks it truly overpays are rare; the big "overpays" were wrong pairings — hence the guard.

import type { LegRule } from '../pedlas/selections'

/** One source's fair probabilities for one fixture, full time. */
export interface FairMarkets {
  moneyline?: { home: number; draw: number; away: number }
  totals: Map<number, number>                                          // line → P(over)
  teamTotals: { home: Map<number, number>; away: Map<number, number> } // line → P(over)
}
export interface RefFixture { id: string; home: string; away: string; start: string; league: string }
export interface RefBoard { source: string; weight: number; fixtures: RefFixture[]; fair: Map<string, FairMarkets> }

export const emptyFair = (): FairMarkets => ({ totals: new Map(), teamTotals: { home: new Map(), away: new Map() } })

/** Power de-vig: p_i = (1/o_i)^k, k chosen so the probabilities sum to 1 (doesn't overrate long shots). */
export function powerDevig(odds: number[]): number[] {
  const inv = odds.map(o => 1 / o)
  let lo = 0.3, hi = 4
  for (let i = 0; i < 60; i++) { const k = (lo + hi) / 2, s = inv.reduce((x, v) => x + Math.pow(v, k), 0); if (s > 1) lo = k; else hi = k }
  const k = (lo + hi) / 2
  return inv.map(v => Math.pow(v, k))
}

/** A source's fair probability for one of our scoreline rules, or null when it has no such market. */
export function fairProbOf(f: FairMarkets, r: LegRule): number | null {
  const ml = f.moneyline
  switch (r.kind) {
    case '1x2': return ml ? (r.pick === 'H' ? ml.home : r.pick === 'A' ? ml.away : ml.draw) : null
    case 'dc': return ml ? (r.pick === 'HD' ? ml.home + ml.draw : r.pick === 'DA' ? ml.draw + ml.away : ml.home + ml.away) : null
    case 'total': { const po = f.totals.get(r.line); return po == null ? null : r.side === 'Over' ? po : 1 - po }
    case 'team_total': { const po = f.teamTotals[r.team].get(r.line); return po == null ? null : r.side === 'Over' ? po : 1 - po }
    default: return null   // BTTS, odd/even, clean sheets: not offered as clean two-ways by the panel
  }
}

// ── matching a SportyBet fixture to a source's fixture ──
const STOP = new Set(['fc', 'cf', 'sc', 'afc', 'ac', 'fk', 'sk', 'if', 'bk', 'club', 'de', 'la', 'the', 'cd', 'ud', 'sd', 'ca', 'cs', 'as', 'us', 'sv', 'vfl', 'vfb', 'tsv', 'nk', 'hnk', 'fbc', 'ss', 'calcio', 'football', 'town', 'city'])
const tokens = (name: string) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\butd\b/g, 'united').replace(/\bst\.?\b/g, 'saint').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t && !STOP.has(t))
export function nameScore(a: string, b: string): number {
  const A = tokens(a), B = tokens(b)
  if (!A.length || !B.length) return 0
  // youth / women / reserve sides must agree — "Italy U21" is not "Italy"
  const tag = (t: string[]) => t.filter(x => /^(u\d\d|w|women|ii|iii|b|reserves?)$/.test(x)).sort().join(',')
  if (tag(A) !== tag(B)) return 0
  let hit = 0
  for (const x of A) if (B.some(y => y === x || (x.length >= 4 && y.length >= 4 && (y.startsWith(x) || x.startsWith(y))))) hit++
  return hit / Math.max(A.length, B.length)
}
/** The source fixture for a SportyBet fixture: same kickoff (±20 min) and both team names agreeing. */
export function matchFixture(game: { home: string; away: string; kickoff: string }, fixtures: RefFixture[]): RefFixture | null {
  const t = Date.parse(game.kickoff)
  let best: RefFixture | null = null, bestScore = 0
  for (const m of fixtures) {
    if (Math.abs(Date.parse(m.start) - t) > 20 * 60_000) continue
    const s = Math.min(nameScore(game.home, m.home), nameScore(game.away, m.away))
    if (s > bestScore) { bestScore = s; best = m }
  }
  return bestScore >= 0.5 ? best : null
}

export interface PanelGame { sources: { source: string; weight: number; fair: FairMarkets }[]; rejected: { source: string; why: string }[] }
/** SportyBet's own 1X2 probabilities for a game, for the mismatch guard. */
export type Own1x2 = { home?: number; draw?: number; away?: number }
const GUARD = 0.12   // a pairing whose 1X2 differs from SportyBet's own by more than this is a wrong match

/** Match every game to every source; keep pairings that pass the guard. */
export function buildPanel(games: { fixtureId: number; home: string; away: string; kickoff: string; own1x2?: Own1x2 }[], boards: RefBoard[]): Map<number, PanelGame> {
  const out = new Map<number, PanelGame>()
  for (const g of games) {
    const pg: PanelGame = { sources: [], rejected: [] }
    for (const b of boards) {
      const m = matchFixture(g, b.fixtures); if (!m) continue
      const f = b.fair.get(m.id); if (!f) continue
      const ml = f.moneyline, own = g.own1x2
      if (ml && own) {
        const diff = Math.max(...(['home', 'draw', 'away'] as const).filter(k => own[k] != null).map(k => Math.abs(ml[k] - own[k]!)))
        if (diff > GUARD) { pg.rejected.push({ source: b.source, why: `1X2 differs from SportyBet's by ${(100 * diff).toFixed(0)} points — likely a different fixture or swapped sides` }); continue }
      }
      pg.sources.push({ source: b.source, weight: b.weight, fair: f })
    }
    out.set(g.fixtureId, pg)
  }
  return out
}

/** Weighted consensus for one pick, with the number of sources and their spread (max − min). */
export function consensus(pg: PanelGame | undefined, r: LegRule): { p: number; n: number; spread: number; by: Record<string, number> } | null {
  if (!pg) return null
  const vals = pg.sources.map(s => ({ s, p: fairProbOf(s.fair, r) })).filter(x => x.p != null && x.p > 0 && x.p < 1) as { s: PanelGame['sources'][number]; p: number }[]
  if (!vals.length) return null
  const w = vals.reduce((x, v) => x + v.s.weight, 0)
  const ps = vals.map(v => v.p)
  return { p: vals.reduce((x, v) => x + v.s.weight * v.p, 0) / w, n: vals.length, spread: Math.max(...ps) - Math.min(...ps), by: Object.fromEntries(vals.map(v => [v.s.source, v.p])) }
}

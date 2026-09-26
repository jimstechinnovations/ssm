/**
 * GET /api/sessions/[id]/games — the games behind a session (the union of every slip's legs), in the
 * session's game order, each with: the two teams' past meetings (total goals), how the session's slips
 * bet this game (pick mix), and the final score once /settle has seen it finish.
 */

import { getSession, listSessionSlips } from '@/lib/sessions/store'
import { getTeamRecent } from '@/lib/pedlas/history-store'

export const runtime = 'nodejs'

type Leg = { fixtureId: number; game: string; league: string; kickoff: string; line: number; side?: string; odds: number; outcome?: string; rule?: unknown; suspended?: boolean }

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  // Union of games across the slips (bot slips have different lengths; legacy slips share one pool).
  const slips = await listSessionSlips(session.id, { withLegs: true, limit: 400 })
  const byGame = new Map<number, { leg: Leg; picks: Map<string, number> }>()
  for (const s of slips) for (const l of (s.legs as Leg[]) ?? []) {
    const e = byGame.get(l.fixtureId) ?? { leg: l, picks: new Map<string, number>() }
    const name = l.outcome ?? `${l.side} ${l.line}`
    e.picks.set(name, (e.picks.get(name) ?? 0) + 1)
    byGame.set(l.fixtureId, e)
  }
  // Persisted live outcomes (from /settle), keyed by fixture — shown per game as it finishes.
  type Outcome = { fixtureId: number; finished: boolean; total: number | null; home?: number | null; away?: number | null; over: boolean | null }
  const outcomes = new Map<number, Outcome>(((session.meta as { gameResults?: Outcome[] } | null)?.gameResults ?? []).map(g => [g.fixtureId, g]))

  const games = await Promise.all([...byGame.values()].map(async ({ leg: l, picks }) => {
    const [home, away] = l.game.split(' vs ').map(s => s.trim())
    const [hr, ar] = await Promise.all([getTeamRecent(home, l.kickoff, 14), getTeamRecent(away, l.kickoff, 14)])
    // STRICTLY the two teams' own meetings (H2H) — no team-form fallback.
    const isH2H = (m: { home: string; away: string }) => (m.home === home && m.away === away) || (m.home === away && m.away === home)
    const h2h = dedupe([...hr, ...ar].filter(isH2H))
    const history = h2h.map(m => ({ date: m.date, total: m.hg + m.ag })).sort((a, b) => a.date.localeCompare(b.date)).slice(-14)
    const overRate = history.length ? history.filter(h => h.total >= 5).length / history.length : null
    return {
      fixtureId: l.fixtureId, game: l.game, league: l.league, kickoff: l.kickoff,
      line: l.rule ? null : l.line, underOdds: l.rule ? null : l.odds,
      picks: [...picks.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      history, overRate, source: history.length ? 'h2h' : 'none', outcome: outcomes.get(l.fixtureId) ?? null,
    }
  }))
  games.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.game.length - b.game.length || a.game.localeCompare(b.game))
  return Response.json({ games, count: games.length, withHistory: games.filter(g => g.history.length > 0).length, withH2H: games.filter(g => g.source === 'h2h').length })
}

function dedupe<T extends { date: string; home: string; away: string; hg: number; ag: number }>(ms: T[]): T[] {
  const seen = new Set<string>()
  return ms.filter(m => { const k = `${m.date}|${m.home}|${m.away}|${m.hg}-${m.ag}`; if (seen.has(k)) return false; seen.add(k); return true })
}

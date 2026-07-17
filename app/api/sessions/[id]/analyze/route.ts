/**
 * POST /api/sessions/[id]/analyze — an honest AI read (NVIDIA NIM) of a session: which games most
 * threaten the all-Under base, and a realistic risk summary. Falls back to a deterministic summary
 * when NIM isn't configured. It NEVER claims an edge — the instruction keeps it honest (−vig scatter).
 */

import { getSession, listSessionSlips } from '@/lib/sessions/store'
import { getTeamRecent } from '@/lib/pedlas/history-store'
import { nimChat, nimConfigured, nimModel } from '@/lib/llm/nim'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  const [base] = await listSessionSlips(session.id, { withLegs: true, limit: 1 })
  const legs = (base?.legs as Array<{ game: string; kickoff: string; odds: number }> | undefined) ?? []
  const games = await Promise.all(legs.map(async l => {
    const [home, away] = l.game.split(' vs ').map(s => s.trim())
    const [hr, ar] = await Promise.all([getTeamRecent(home, l.kickoff, 8), getTeamRecent(away, l.kickoff, 8)])
    const hist = [...hr, ...ar].map(m => m.hg + m.ag)
    const overRate = hist.length ? hist.filter(t => t >= 5).length / hist.length : null
    return { game: l.game, underOdds: l.odds, overRate, n: hist.length }
  }))
  const withHist = games.filter(g => g.overRate != null)
  const riskiest = [...withHist].sort((a, b) => (b.overRate! - a.overRate!) || (a.underOdds - b.underOdds)).slice(0, 6)
  const pAny = (session.meta as { pAnyWin?: number } | null)?.pAnyWin

  // deterministic fallback (also the data the model reasons over)
  const facts = {
    games: legs.length, withHistory: withHist.length, budget: session.budget, target: session.targetWin,
    pAnyWin: pAny, riskiest: riskiest.map(g => ({ game: g.game, overPct: Math.round((g.overRate ?? 0) * 100), n: g.n, underOdds: g.underOdds })),
  }
  const deterministic =
    `${legs.length}-game all-Under base; only ${withHist.length} have history. ` +
    (riskiest.length
      ? `Highest Over-4.5 history: ${riskiest.slice(0, 3).map(g => `${g.game} (${Math.round((g.overRate ?? 0) * 100)}%)`).join(', ')}. `
      : 'No history to flag specific games. ') +
    `Modelled P(≥1 win) ${pAny != null ? (100 * pAny).toFixed(1) + '%' : '—'} — every slip is −vig; treat as a high-variance scatter, not an edge.`

  if (!nimConfigured()) return Response.json({ summary: deterministic, source: 'deterministic' })

  try {
    const summary = await nimChat([
      { role: 'system', content: 'You are an honest betting-risk analyst. NEVER claim an edge or predict profit — these total-goals markets are −vig and models do not beat them. Be concise (3-4 sentences), concrete, and grounded ONLY in the data given.' },
      { role: 'user', content: `A PEDLA coverage session bets an all-Under-4.5 base across many games plus flipped variants. Data:\n${JSON.stringify(facts, null, 2)}\nGive a short, honest read: which games most threaten the all-Under base (by history), how realistic the P(≥1 win) is, and one caveat. No edge claims.` },
    ], { temperature: 0, maxTokens: 400, timeoutMs: 45_000 })
    return Response.json({ summary: summary.trim() || deterministic, source: 'nim', model: nimModel() })
  } catch (e) {
    return Response.json({ summary: deterministic, source: 'deterministic', note: e instanceof Error ? e.message.slice(0, 120) : 'nim error' })
  }
}

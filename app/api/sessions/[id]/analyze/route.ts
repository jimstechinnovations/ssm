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

  // Games = union across slips (Decision Bot slips differ in length); the pick mix shows how the family
  // bets each game (Decision Bot) or how many slips flipped it (legacy Under-4.5 books).
  const slips = await listSessionSlips(session.id, { withLegs: true, limit: 300 })
  const byGame = new Map<number, { game: string; kickoff: string; picks: Map<string, number> }>()
  for (const s of slips) for (const l of (s.legs as Array<{ fixtureId: number; game: string; kickoff: string; outcome?: string; side?: string; line?: number }>) ?? []) {
    const g = byGame.get(l.fixtureId) ?? { game: l.game, kickoff: l.kickoff, picks: new Map<string, number>() }
    const name = l.outcome ?? `${l.side} ${l.line}`
    g.picks.set(name, (g.picks.get(name) ?? 0) + 1); byGame.set(l.fixtureId, g)
  }
  const games = await Promise.all([...byGame.values()].map(async g => {
    const [home, away] = g.game.split(' vs ').map(s => s.trim())
    const [hr, ar] = await Promise.all([getTeamRecent(home, g.kickoff, 8), getTeamRecent(away, g.kickoff, 8)])
    const hist = [...hr, ...ar].map(m => m.hg + m.ag)
    return {
      game: g.game, n: hist.length, avgGoals: hist.length ? +(hist.reduce((a, b) => a + b, 0) / hist.length).toFixed(2) : null,
      fivePlusPct: hist.length ? Math.round(100 * hist.filter(t => t >= 5).length / hist.length) : null,
      picks: [...g.picks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name} ×${count}`),
    }
  }))
  const withHist = games.filter(g => g.n > 0)
  const meta = session.meta as { pAnyWin?: number; engine?: string; bookMetas?: Record<string, { keepRate?: number }> } | null
  const pAny = meta?.pAnyWin
  const keep = meta?.bookMetas ? Object.values(meta.bookMetas).find(m => m.keepRate != null)?.keepRate : undefined
  const engine = meta?.engine === 'decision_bot' ? 'Decision Bot (mixed two-sided markets per game, every slip paying ≈ the target)' : 'total-goals coverage (Under/Over lines)'
  // most-contested games = where the slips' picks are most concentrated on one selection (one result kills many)
  const concentrated = [...games].map(g => ({ ...g, top: Number(/×(\d+)/.exec(g.picks[0] ?? '')?.[1] ?? 0) })).sort((a, b) => b.top - a.top).slice(0, 5)

  const facts = {
    currency: 'NGN (₦) — always write amounts in ₦, never £ or $',
    // stake makeup: jackpot slips vs floor tickets (Flexi "k of N" — a small payout that lands often)
    slipsByStake: Object.entries(slips.reduce((m: Record<string, number>, sl) => { const d = (sl as { decision?: { product?: string } | null }).decision; const k = `${d?.product === 'flexi' ? 'floor ticket (Flexi, small payout, lands often)' : 'jackpot slip (pays ≈ the target)'} at ₦${Number((sl as { stake?: number }).stake ?? 0)}`; m[k] = (m[k] ?? 0) + 1; return m }, {})).map(([kind, count]) => ({ kind, count })),
    engine, slips: slips.length, games: games.length, withHistory: withHist.length, budget: session.budget, target: session.targetWin,
    pAnyWin: pAny, returnsPer100: keep != null ? Math.round(keep * 100) : null,
    mostConcentratedGames: concentrated.map(g => ({ game: g.game, picks: g.picks, avgGoals: g.avgGoals, fivePlusPct: g.fivePlusPct })),
  }
  const deterministic =
    `${slips.length} slips over ${games.length} games (${withHist.length} with history), built by the ${engine}. ` +
    (concentrated.length ? `Most slips ride on: ${concentrated.slice(0, 3).map(g => `${g.game} (${g.picks[0]})`).join(', ')} — one result there decides many slips at once. ` : '') +
    `Chance ≥1 slip wins ${pAny != null ? (100 * pAny).toFixed(2) + '%' : '—'}${keep != null ? `; on average ₦100 staked returns ₦${Math.round(keep * 100)}` : ''} — every slip is −vig; a spread of long shots, not an edge.`

  if (!nimConfigured()) return Response.json({ summary: deterministic, source: 'deterministic' })

  try {
    const summary = await nimChat([
      { role: 'system', content: 'You are an honest betting-risk analyst. NEVER claim an edge or predict profit — these markets are priced with a margin and models do not beat them. Be concise (3-4 sentences), concrete, and grounded ONLY in the data given — never invent stakes, odds or amounts. Currency is Nigerian naira (₦).' },
      { role: 'user', content: `A betting session spreads a budget over many accumulator slips. Data:\n${JSON.stringify(facts, null, 2)}\nGive a short, honest read: which games carry the most slips on one result (and what their history says), how realistic the chance of ≥1 win is, and one caveat. No edge claims.` },
    ], { temperature: 0, maxTokens: 1200, timeoutMs: 60_000 })
    return Response.json({ summary: summary.trim() || deterministic, source: 'nim', model: nimModel() })
  } catch (e) {
    return Response.json({ summary: deterministic, source: 'deterministic', note: e instanceof Error ? e.message.slice(0, 120) : 'nim error' })
  }
}

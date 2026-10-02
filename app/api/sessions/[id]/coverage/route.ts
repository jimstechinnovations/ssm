/**
 * GET /api/sessions/[id]/coverage[?combine=day][&site=1] — "do we have enough survivors?", both ways.
 *
 * Mode is automatic:
 *  - `live`: the session has placed slips → the family is what was actually staked; finished games settle
 *    legs, games IN PLAY kill legs that can no longer win (as SportyBet does), and the rest is simulated.
 *  - `plan`: nothing placed yet → the family is the built slips, before a naira is staked: which games are
 *    one-sided, how deep at least one slip survives, and what more slips/budget would buy.
 *
 * `combine=day` adds every other session created the same day that has placed slips (one budget is often
 * split across several sessions — the operator thinks in "my 16 slips", not per session).
 * `site=1` also reads the account's open bets from SportyBet (needs the prepared browser) and matches each
 * to our slip by its exact selections, so the app's count and the site's count can be reconciled.
 * Read-only. The maths is in lib/pedlas/survivors.ts.
 */

import { getSession, listSessions, listSessionSlips, effectivePayout, type SessionRow } from '@/lib/sessions/store'
import { fetchResults } from '@/lib/pedlas/results'
import { legRuleOf, type LegRule } from '@/lib/pedlas/selections'
import { analyzeCoverage, type CovGame, type CovSlip } from '@/lib/pedlas/survivors'
import { fetchOpenBets, selectionSig } from '@/lib/books/sportybet-bets'

export const runtime = 'nodejs'
export const maxDuration = 120

type Leg = { fixtureId: number; game?: string; kickoff?: string; rule?: LegRule; line?: number; side?: string; outcome?: string; odds?: number; p?: number | null; marketId?: string; specifier?: string; outcomeId?: string; suspended?: boolean }
const PLACED = ['placed', 'won', 'lost']

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const url = new URL(request.url)
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  // the family: this session (+ same-day siblings with placed slips)
  let sessions: SessionRow[] = [session]
  if (url.searchParams.get('combine') === 'day') {
    const day = session.createdAt.slice(0, 10)
    sessions = (await listSessions(80)).filter(s => s.createdAt.slice(0, 10) === day && s.status !== 'failed')
  }
  let rows = (await Promise.all(sessions.map(async s => (await listSessionSlips(s.id, { withLegs: true })).map(r => ({ ...r, code: s.code }))))).flat()
  // a session with nothing placed is always checked on its own (pre-placement), even when combining
  if (!rows.some(r => r.code === session.code && PLACED.includes(r.status))) { sessions = [session]; rows = rows.filter(r => r.code === session.code) }
  const placed = rows.filter(r => PLACED.includes(r.status))
  const mode: 'live' | 'plan' = placed.length ? 'live' : 'plan'
  // floor tickets (Flexi "k of N") aren't jackpot slips — one wrong leg doesn't end them — so they're
  // left out of the survival maths here
  const family = (mode === 'live' ? placed : rows.filter(r => r.status !== 'failed' && r.code === session.code))
    .filter(r => (r.legs as Leg[] | undefined)?.length && (r.decision as { product?: string } | null)?.product !== 'flexi')
  if (!family.length) return Response.json({ error: 'no slips to analyse' }, { status: 409 })

  const slips: CovSlip[] = family.map(r => ({
    key: `${r.code}#${r.slipId}`, slipId: r.slipId, session: r.code, stake: r.stake, payout: effectivePayout(r),
    legs: (r.legs as Leg[]).filter(l => !l.suspended).flatMap(l => {
      const rule = legRuleOf(l); if (!rule) return []
      const p = typeof l.p === 'number' && l.p > 0 ? l.p : l.odds ? 1 / (l.odds * 1.05) : 0.5
      return [{ fixtureId: l.fixtureId, rule, name: l.outcome ?? (l.side ? `${l.side} ${l.line}` : 'pick'), p }]
    }),
  }))

  // games + their state (final / in play / not started)
  const gmeta = new Map<number, { game: string; kickoff: string }>()
  for (const r of family) for (const l of r.legs as Leg[]) if (!gmeta.has(l.fixtureId)) gmeta.set(l.fixtureId, { game: l.game ?? String(l.fixtureId), kickoff: l.kickoff ?? '' })
  const now = Date.now()
  const started = [...gmeta.entries()].filter(([, g]) => !g.kickoff || Date.parse(g.kickoff) <= now).map(([fid]) => fid)
  const results = started.length ? await fetchResults(started) : new Map()
  const games: CovGame[] = [...gmeta.entries()].map(([fixtureId, g]) => {
    const r = results.get(fixtureId)
    const state: CovGame['state'] = r?.finished && r.home != null && r.away != null ? { kind: 'final', h: r.home, a: r.away }
      : r?.live && r.home != null && r.away != null ? { kind: 'live', h: r.home, a: r.away, minute: r.minute ?? 45 }
      : { kind: 'pending' }
    return { fixtureId, game: g.game, kickoff: g.kickoff, state }
  })

  const stake = session.minStake || slips[0].stake
  const cov = analyzeCoverage(games, slips, { stake, target: session.targetWin, days: 20000 })

  // SportyBet's own view, matched slip by slip
  let site: Record<string, unknown> | null = null
  if (url.searchParams.get('site') === '1') {
    try {
      const open = await fetchOpenBets()
      const openSigs = new Map(open.map(b => [selectionSig(b.selections), b]))
      const sigOf = (r: (typeof family)[number]) => selectionSig((r.legs as Leg[]).filter(l => !l.suspended).map(l => l.marketId
        ? { fixtureId: l.fixtureId, marketId: String(l.marketId), specifier: l.specifier ?? '', outcomeId: String(l.outcomeId) }
        : { fixtureId: l.fixtureId, marketId: '18', specifier: `total=${l.line}`, outcomeId: l.side === 'Under' ? '13' : '12' }))
      const openKeys = new Set(family.filter(r => openSigs.has(sigOf(r))).map(r => `${r.code}#${r.slipId}`))
      const aliveKeys = new Set(cov.aliveSlips.map(s => s.key))
      site = {
        openOnAccount: open.length,
        openInFamily: openKeys.size,
        aliveHereSettledOnSite: [...aliveKeys].filter(k => !openKeys.has(k)),       // site already settled (usually lost early)
        openOnSiteDeadHere: [...openKeys].filter(k => !aliveKeys.has(k)),           // site hasn't settled a finished/decided game yet
        openNotInFamily: open.length - openKeys.size,
      }
    } catch (e) { site = { error: e instanceof Error ? e.message : String(e) } }
  }

  return Response.json({ mode, sessions: sessions.map(s => s.code), generatedAt: new Date().toISOString(), ...cov, site })
}

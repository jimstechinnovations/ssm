// lib/pedlas/coverage-run.ts — survivors now / both ways / slips & budget for a session (see survivors.ts).
// Shared by GET /api/sessions/[id]/coverage and the live monitor (lib/monitor/tick.ts).

import { getSession, listSessions, listSessionSlips, effectivePayout, cashOutSessionSlip, type SessionRow } from '@/lib/sessions/store'
import { fetchResults } from '@/lib/pedlas/results'
import { legRuleOf, type LegRule } from '@/lib/pedlas/selections'
import { analyzeCoverage, type CovGame, type CovSlip } from '@/lib/pedlas/survivors'
import { fetchOpenBets, fetchSettledBets, selectionSig, type SiteBet } from '@/lib/books/sportybet-bets'


type Leg = { fixtureId: number; game?: string; kickoff?: string; rule?: LegRule; line?: number; side?: string; outcome?: string; odds?: number; p?: number | null; marketId?: string; specifier?: string; outcomeId?: string; suspended?: boolean }
const PLACED = ['placed', 'won', 'lost', 'cashed_out']   // cashed_out: staked and settled by the operator on the site
type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>

export async function runCoverage(session: Session, opts: { combine?: boolean; site?: boolean } = {}) {
  // the family: this session (+ same-day siblings with placed slips)
  let sessions: SessionRow[] = [session]
  if (opts.combine === true) {
    const day = session.createdAt.slice(0, 10)
    sessions = (await listSessions(80)).filter(s => s.createdAt.slice(0, 10) === day && s.status !== 'failed')
  }
  let rows = (await Promise.all(sessions.map(async s => (await listSessionSlips(s.id, { withLegs: true })).map(r => ({ ...r, code: s.code }))))).flat()
  // a session with nothing placed is always checked on its own (pre-placement), even when combining
  if (!rows.some(r => r.code === session.code && PLACED.includes(r.status))) { sessions = [session]; rows = rows.filter(r => r.code === session.code) }
  const placed = rows.filter(r => PLACED.includes(r.status))
  const mode: 'live' | 'plan' = placed.length ? 'live' : 'plan'
  const sigOf = (r: (typeof rows)[number]) => selectionSig((r.legs as Leg[]).filter(l => !l.suspended).map(l => l.marketId
    ? { fixtureId: l.fixtureId, marketId: String(l.marketId), specifier: l.specifier ?? '', outcomeId: String(l.outcomeId) }
    : { fixtureId: l.fixtureId, marketId: '18', specifier: `total=${l.line}`, outcomeId: l.side === 'Under' ? '13' : '12' }))

  // CASH-OUTS (2026-10-04: the operator cashed out #22 for ₦487.81 and the app still counted it alive).
  // With the site check on, any slip still 'placed' here but no longer open on SportyBet is looked up in the
  // settled bets by its booking code; a cash-out is recorded BEFORE the survival maths, so it leaves the
  // family at once and its money counts as returned. Results never touch it afterwards.
  let open: SiteBet[] | null = null, siteError: string | null = null
  const cashedOut: { key: string; slipId: number; paid: number }[] = []
  if (opts.site === true && mode === 'live') {
    try {
      open = await fetchOpenBets()
      const openSigs = new Set(open.map(b => selectionSig(b.selections)))
      const gone = placed.filter(r => r.status === 'placed' && r.bookingCode && !openSigs.has(sigOf(r)))
      if (gone.length) {
        const since = Math.min(...sessions.map(s => Date.parse(s.createdAt))) - 3_600_000
        const want = new Set(gone.map(r => r.bookingCode))
        const settled = await fetchSettledBets({ since, until: bets => [...want].every(c => bets.some(b => b.code === c)) })
        for (const r of gone) {
          // newest settled bet with this code, placed after the session began, same stake (codes get reused)
          const b = settled.find(x => x.code === r.bookingCode && x.createdAt >= since && Math.abs(x.stake - Number(r.siteStake ?? r.stake)) < 0.5)
          if (b?.cashedOut && await cashOutSessionSlip(sessions.find(s => s.code === r.code)!.id, r.slipId, b.paid)) {
            r.status = 'cashed_out'; r.settled = true; r.returned = b.paid
            cashedOut.push({ key: `${r.code}#${r.slipId}`, slipId: r.slipId, paid: b.paid })
          }
        }
      }
    } catch (e) { siteError = e instanceof Error ? e.message : String(e) }
  }

  // floor tickets (Flexi "k of N") aren't jackpot slips — one wrong leg doesn't end them — and a cashed-out
  // slip no longer rides on anything, so both are left out of the survival maths here
  const family = (mode === 'live' ? placed.filter(r => r.status !== 'cashed_out') : rows.filter(r => r.status !== 'failed' && r.code === session.code))
    .filter(r => (r.legs as Leg[] | undefined)?.length && (r.decision as { product?: string } | null)?.product !== 'flexi')
  if (!family.length) return { error: 'no slips to analyse' as const }

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
  if (opts.site === true) {
    try {
      if (siteError) throw new Error(siteError)
      if (!open) open = await fetchOpenBets()
      const openSigs = new Map(open.map(b => [selectionSig(b.selections), b]))
      const openKeys = new Set(family.filter(r => openSigs.has(sigOf(r))).map(r => `${r.code}#${r.slipId}`))
      const aliveKeys = new Set(cov.aliveSlips.map(s => s.key))
      site = {
        openOnAccount: open.length,
        openInFamily: openKeys.size,
        aliveHereSettledOnSite: [...aliveKeys].filter(k => !openKeys.has(k)),       // site already settled (usually lost early)
        openOnSiteDeadHere: [...openKeys].filter(k => !aliveKeys.has(k)),           // site hasn't settled a finished/decided game yet
        // against EVERY placed slip, floor tickets included (they're not in the jackpot family — counting them
        // as strangers raised a false "37 open bets not in this session" on 2026-10-03)
        openNotInFamily: open.length - placed.filter(r => openSigs.has(sigOf(r))).length,
        cashedOut,                                                                   // recorded by this check
      }
    } catch (e) { site = { error: e instanceof Error ? e.message : String(e) } }
  }

  return { mode, sessions: sessions.map(s => s.code), generatedAt: new Date().toISOString(), ...cov, site }
}

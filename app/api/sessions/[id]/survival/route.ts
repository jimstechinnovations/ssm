/**
 * GET /api/sessions/[id]/survival — the per-game survival curve + odds-bucket calibration for a placed
 * session (optimum-plan §5). For each game in kickoff order it computes, from the REAL slips and live
 * results: the book's Under odds (bucket), the finished outcome (FT total, O/U), how many still-alive
 * slips that game cut, and how many survive after it. Also buckets every finished game by its Under
 * odds and compares the realised Over-4.5 rate to the (approx) implied rate — the §5F hypothesis.
 * Read-only analysis; persists a snapshot to meta.learnings (touch:false) so the dataset is kept.
 */

import { getSession, updateSession, listSessionSlips } from '@/lib/sessions/store'
import { fetchResults } from '@/lib/pedlas/results'
import { legOutcome, type SlipLeg } from '@/lib/pedlas/settle-slips'

export const runtime = 'nodejs'
export const maxDuration = 120

type Leg = SlipLeg & { game?: string; league?: string; kickoff?: string; odds?: number; outcome?: string; suspended?: boolean }
const bucketOf = (o: number) => o < 1.1 ? '1.00–1.10' : o < 1.2 ? '1.10–1.20' : o < 1.35 ? '1.20–1.35' : '1.35+'

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  const slips = await listSessionSlips(session.id, { withLegs: true })
  // floor tickets (Flexi "k of N") survive a wrong leg — they're not part of the jackpot survival curve
  const placed = slips.filter(s => ['placed', 'won', 'lost'].includes(s.status) && (s.legs as Leg[])?.length && (s.decision as { product?: string } | null)?.product !== 'flexi')
  if (placed.length === 0) return Response.json({ error: 'no placed slips to analyse' }, { status: 409 })
  // Each slip = its legs ACTUALLY placed, keyed by game (dropped/suspended legs weren't staked).
  const legMaps = placed.map(s => {
    const m = new Map<number, Leg>()
    for (const l of s.legs as Leg[]) if (!l.suspended) m.set(l.fixtureId, l)
    return m
  })

  // Game set across all slips. underOdds only exists for legacy Under/Over books (bucket analysis).
  const gmap = new Map<number, { fixtureId: number; game: string; league: string; kickoff: string; line: number; underOdds: number }>()
  for (const s of placed) for (const l of s.legs as Leg[]) {
    const g = gmap.get(l.fixtureId) ?? { fixtureId: l.fixtureId, game: l.game ?? String(l.fixtureId), league: l.league ?? '—', kickoff: l.kickoff ?? '', line: l.rule ? 0 : (l.line ?? 4.5), underOdds: 0 }
    if (!l.rule && l.side === 'Under' && l.odds && !g.underOdds) g.underOdds = l.odds
    gmap.set(l.fixtureId, g)
  }
  const games = [...gmap.values()].sort((a, b) => (a.kickoff || '').localeCompare(b.kickoff || ''))
  const leagueOf = new Map(games.map(g => [g.fixtureId, g.league]))
  const legacy = games.every(g => g.line > 0)

  const results = await fetchResults(games.map(g => g.fixtureId))

  // Walk games in kickoff order; a slip stays alive iff every FINISHED game's leg won (rule-aware, so
  // Under/Over and Decision Bot markets — 1X2, BTTS, clean sheets … — are judged by the same rule).
  let alive = legMaps.map((_, i) => i)
  const curve = games.map((g, order) => {
    const r = results.get(g.fixtureId)
    const finished = !!r?.finished
    const total = finished ? (r?.total ?? null) : null
    const over = finished && g.line > 0 ? (total! > g.line) : null
    let cut = 0
    let cutSlipIds: number[] = [], aliveSlipIdsAfter: number[] = []
    // UNBIASED per-game view: every slip's leg on this game, alive or not. `cut` alone is survivorship-
    // biased — a late game can't cut slips that are already dead, so "cut 0" there says nothing about
    // how safe the game was. legHitRate vs expectedHitRate (mean of the bot's own p) is the calibration check.
    let legs = 0, legWins = 0, expectedWins = 0
    if (finished) for (const m of legMaps) {
      const l = m.get(g.fixtureId) as (Leg & { p?: number }) | undefined
      if (!l) continue
      const w = legOutcome(l, r)
      if (w === null) continue
      legs++; if (w) legWins++
      expectedWins += typeof l.p === 'number' ? l.p : (l.odds ? 1 / l.odds : 0)
    }
    if (finished) {
      const survivors = alive.filter(i => { const l = legMaps[i].get(g.fixtureId); return !l || legOutcome(l, r) !== false })
      cut = alive.length - survivors.length
      cutSlipIds = alive.filter(i => !survivors.includes(i)).map(i => placed[i].slipId)
      alive = survivors
      aliveSlipIdsAfter = alive.map(i => placed[i].slipId)
    }
    // how many slips bet this game on the breakout side (legacy Over) — the hedge weight on it
    const overSlips = legMaps.filter(m => { const l = m.get(g.fixtureId); return l && !l.rule && l.side === 'Over' }).length
    const underOdds = g.underOdds || 1
    return {
      order: order + 1, fixtureId: g.fixtureId, game: g.game, kickoff: g.kickoff,
      underOdds, bucket: bucketOf(underOdds), overSlips,
      finished, total, score: finished && r?.home != null ? `${r.home}-${r.away}` : null, over, cut, aliveAfter: alive.length,
      cutSlipIds, aliveSlipIdsAfter,
      legs, legWins, expectedWins: Math.round(expectedWins * 100) / 100,
      legHitRate: legs ? legWins / legs : null, expectedHitRate: legs ? expectedWins / legs : null,
    }
  })

  // §5F (legacy Under-4.5 books only): realised Over rate by Under-odds bucket vs approx implied.
  const buckets: Record<string, { games: number; overs: number; impliedOverSum: number }> = {}
  if (legacy) for (const c of curve) {
    if (!c.finished) continue
    const b = (buckets[c.bucket] ??= { games: 0, overs: 0, impliedOverSum: 0 })
    b.games++; if (c.over) b.overs++
    b.impliedOverSum += Math.max(0, Math.min(1, 1 - 1 / c.underOdds))
  }
  const bucketRows = Object.entries(buckets).map(([range, b]) => ({
    range, games: b.games, realisedOverRate: b.games ? b.overs / b.games : null,
    impliedOverApprox: b.games ? b.impliedOverSum / b.games : null,
  })).sort((a, b) => a.range.localeCompare(b.range))

  const finishedCount = curve.filter(c => c.finished).length
  let run = 0, maxOverRun = 0, overs = 0
  for (const c of curve) {
    if (!c.finished) { run = 0; continue }
    if (c.total != null && c.total >= 5) { overs++; run++; if (run > maxOverRun) maxOverRun = run } else run = 0
  }
  const realised = {
    overs, finished: finishedCount, overFraction: finishedCount ? overs / finishedCount : null,
    maxOverRun, layer1_over50: finishedCount ? overs / finishedCount > 0.5 : null,
  }

  // Per-LEAGUE: how many slips each competition's results cut, and how often games there went 5+.
  const lg: Record<string, { games: number; overs: number; cut: number }> = {}
  for (const c of curve) {
    if (!c.finished) continue
    const name = leagueOf.get(c.fixtureId) || '—'
    const b = (lg[name] ??= { games: 0, overs: 0, cut: 0 })
    b.games++; if (c.total != null && c.total >= 5) b.overs++; b.cut += c.cut
  }
  const leagues = Object.entries(lg).map(([league, b]) => ({
    league, games: b.games, overs: b.overs, overRate: b.games ? b.overs / b.games : null, slipsCut: b.cut,
  })).sort((a, b) => b.slipsCut - a.slipsCut)

  let topIdx = 0
  for (let i = 1; i < placed.length; i++) if ((placed[i].sitePayout ?? placed[i].potentialPayout ?? 0) > (placed[topIdx].sitePayout ?? placed[topIdx].potentialPayout ?? 0)) topIdx = i
  const aliveSet = new Set(alive)
  const top = placed[topIdx]
  const topSlip = {
    slipId: top.slipId, bookingCode: top.bookingCode, payout: top.sitePayout ?? top.potentialPayout ?? 0,
    overs: [...legMaps[topIdx].values()].filter(l => !l.rule && l.side === 'Over').length,
    status: top.status, alive: aliveSet.has(topIdx),
  }
  const winnerSlip = placed.find(s => s.status === 'won')
  const winner = winnerSlip ? { slipId: winnerSlip.slipId, bookingCode: winnerSlip.bookingCode, payout: winnerSlip.returned ?? winnerSlip.sitePayout ?? winnerSlip.potentialPayout ?? 0 } : null

  const snapshot = {
    at: new Date().toISOString(), total: legMaps.length, alive: alive.length, dead: legMaps.length - alive.length,
    finishedGames: finishedCount, ofGames: games.length, realised, curve, buckets: bucketRows, leagues, topSlip, winner,
  }
  // keep the dataset (don't bump the placer heartbeat)
  await updateSession(session.id, { meta: { ...(session.meta ?? {}), learnings: snapshot } }, { touch: false })
  return Response.json(snapshot)
}

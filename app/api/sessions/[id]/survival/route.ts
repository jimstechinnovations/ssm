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
import type { SlipLeg } from '@/lib/pedlas/settle-slips'

export const runtime = 'nodejs'
export const maxDuration = 120

type Leg = SlipLeg & { game?: string; league?: string; kickoff?: string; odds?: number; side: 'Under' | 'Over' }
const bucketOf = (o: number) => o < 1.1 ? '1.00–1.10' : o < 1.2 ? '1.10–1.20' : o < 1.35 ? '1.20–1.35' : '1.35+'

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  // Every slip's per-game side (its exact vector), from the placed slips.
  const slips = await listSessionSlips(session.id, { withLegs: true, limit: 2000 })
  const placed = slips.filter(s => ['placed', 'won', 'lost'].includes(s.status) && (s.legs as Leg[])?.length)
  if (placed.length === 0) return Response.json({ error: 'no placed slips to analyse' }, { status: 409 })
  const vectors = placed.map(s => {
    const side = new Map<number, 'Under' | 'Over'>()
    for (const l of s.legs as Leg[]) side.set(l.fixtureId, l.side)
    return side
  })

  // Game set: scan ALL slips' legs. underOdds = the price on any leg where the game is Under (every
  // game is Under in most slips), so it's always found regardless of which slip we look at.
  const gmap = new Map<number, { fixtureId: number; game: string; league: string; kickoff: string; line: number; underOdds: number }>()
  for (const s of placed) for (const l of s.legs as Leg[]) {
    const g = gmap.get(l.fixtureId) ?? { fixtureId: l.fixtureId, game: l.game ?? String(l.fixtureId), league: l.league ?? '—', kickoff: l.kickoff ?? '', line: l.line ?? 4.5, underOdds: 0 }
    if (l.side === 'Under' && l.odds && !g.underOdds) g.underOdds = l.odds
    gmap.set(l.fixtureId, g)
  }
  const games = [...gmap.values()].map(g => ({ ...g, underOdds: g.underOdds || 1 })).sort((a, b) => (a.kickoff || '').localeCompare(b.kickoff || ''))
  const leagueOf = new Map(games.map(g => [g.fixtureId, g.league]))

  const results = await fetchResults(games.map(g => g.fixtureId))

  // Walk games in kickoff order; a slip stays alive iff its side matches every FINISHED game so far.
  let alive = vectors.map((_, i) => i)   // indices into vectors
  const curve = games.map((g, order) => {
    const r = results.get(g.fixtureId)
    const finished = !!r?.finished
    const total = finished ? (r?.total ?? null) : null
    const over = finished ? (total! > g.line) : null
    const outcomeSide: 'Under' | 'Over' | null = over == null ? null : over ? 'Over' : 'Under'
    let cut = 0
    if (outcomeSide) {
      const survivors = alive.filter(i => vectors[i].get(g.fixtureId) === outcomeSide)
      cut = alive.length - survivors.length
      alive = survivors
    }
    // how many slips (of the whole book) put this game Over — the hedge weight on it
    const overSlips = vectors.filter(v => v.get(g.fixtureId) === 'Over').length
    return {
      order: order + 1, fixtureId: g.fixtureId, game: g.game, kickoff: g.kickoff,
      underOdds: g.underOdds, bucket: bucketOf(g.underOdds), overSlips,
      finished, total, over, cut, aliveAfter: alive.length,
    }
  })

  // §5F: bucket every FINISHED game by Under odds; realised Over rate vs approx implied.
  const buckets: Record<string, { games: number; overs: number; impliedOverSum: number }> = {}
  for (const c of curve) {
    if (!c.finished) continue
    const b = (buckets[c.bucket] ??= { games: 0, overs: 0, impliedOverSum: 0 })
    b.games++; if (c.over) b.overs++
    b.impliedOverSum += Math.max(0, Math.min(1, 1 - 1 / c.underOdds))   // approx implied P(Over), upper bound
  }
  const bucketRows = Object.entries(buckets).map(([range, b]) => ({
    range, games: b.games, realisedOverRate: b.games ? b.overs / b.games : null,
    impliedOverApprox: b.games ? b.impliedOverSum / b.games : null,
  })).sort((a, b) => a.range.localeCompare(b.range))

  const finishedCount = curve.filter(c => c.finished).length
  // Realised layer checks (validate P and E against reality): Over-fraction of the finished day and
  // the longest run of consecutive-by-kickoff Over results. An unfinished game breaks a run ("so far").
  let run = 0, maxOverRun = 0, overs = 0
  for (const c of curve) {
    if (!c.finished) { run = 0; continue }
    if (c.over) { overs++; run++; if (run > maxOverRun) maxOverRun = run } else run = 0
  }
  const realised = {
    overs, finished: finishedCount, overFraction: finishedCount ? overs / finishedCount : null,
    maxOverRun, layer1_over50: finishedCount ? overs / finishedCount > 0.5 : null, // true = a >50%-Over day (Layer 1 would have pruned reality)
  }

  // Per-LEAGUE calibration: which competitions stayed Under (our friend) vs went Over (the cutters).
  // "Where we survive most" = lowest Over rate. Directional across sessions → maybe restrict selection.
  const lg: Record<string, { games: number; overs: number; cut: number }> = {}
  for (const c of curve) {
    if (!c.finished) continue
    const name = leagueOf.get(c.fixtureId) || '—'
    const b = (lg[name] ??= { games: 0, overs: 0, cut: 0 })
    b.games++; if (c.over) b.overs++; b.cut += c.cut
  }
  const leagues = Object.entries(lg).map(([league, b]) => ({
    league, games: b.games, overs: b.overs, overRate: b.games ? b.overs / b.games : null, slipsCut: b.cut,
  })).sort((a, b) => (a.overRate ?? 1) - (b.overRate ?? 1))   // safest (lowest Over rate) first

  // The biggest-jackpot slip (the "dream" ticket): its code, payout, and whether it's still alive.
  let topIdx = 0
  for (let i = 1; i < placed.length; i++) if ((placed[i].potentialPayout ?? 0) > (placed[topIdx].potentialPayout ?? 0)) topIdx = i
  const aliveSet = new Set(alive)
  const top = placed[topIdx]
  const topSlip = {
    slipId: top.slipId, bookingCode: top.bookingCode, payout: top.potentialPayout ?? 0,
    overs: [...vectors[topIdx].values()].filter(s => s === 'Over').length,
    status: top.status, alive: aliveSet.has(topIdx),
  }
  const winnerSlip = placed.find(s => s.status === 'won')
  const winner = winnerSlip ? { slipId: winnerSlip.slipId, bookingCode: winnerSlip.bookingCode, payout: winnerSlip.returned ?? winnerSlip.potentialPayout ?? 0 } : null

  const snapshot = {
    at: new Date().toISOString(), total: vectors.length, alive: alive.length, dead: vectors.length - alive.length,
    finishedGames: finishedCount, ofGames: games.length, realised, curve, buckets: bucketRows, leagues, topSlip, winner,
  }
  // keep the dataset (don't bump the placer heartbeat)
  await updateSession(session.id, { meta: { ...(session.meta ?? {}), learnings: snapshot } }, { touch: false })
  return Response.json(snapshot)
}

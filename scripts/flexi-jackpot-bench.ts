// scripts/flexi-jackpot-bench.ts — would a FLEXI ticket that pays the jackpot target (e.g. "7 of 8 → ₦51k")
// beat a plain accumulator at the same target? (the operator's idea, 2026-10-04: "a floor slip whose return
// is our target is the moonshot")
//
// Same live board, same legs, same rule for both: legs are taken best value first (fair P × odds, one per
// game, odds MIN_ODDS–3.5, at most MAX_LEGS legs), added until the ticket pays the target. Plain = odds product + SportyBet's live Multi
// Bet Bonus; Flexi = SportyBet's exact formula (lib/books/sportybet-flexi.ts, no bonus). Each ticket is
// scored at FAIR prices (the Pinnacle/Kambi panel where they agree, else the book de-margined):
//   keep  = P(ticket pays) × payout ÷ stake       — what ₦1 is worth; P(≥1 win) for a family ≈ keep × budget ÷ target
//   P     = the ticket's own chance of paying the target
// Builds TICKETS tickets per product on disjoint games (fresh games for each), so it's not one lucky pick.
//
//   npx tsx --env-file=.env --conditions=react-server scripts/flexi-jackpot-bench.ts [stake] [target] [tickets]
import { sportybet } from '../lib/books/sportybet'
import { loadPanel } from '../lib/books/panel'
import { consensus } from '../lib/books/reference'
import { fetchSportyBonusPlan, sportyBonus } from '../lib/books/sportybet-bonus'
import { flexiOdds, correctDist, atLeast } from '../lib/books/sportybet-flexi'
import type { Selection } from '../lib/pedlas/selections'

const stake = Number(process.argv[2] ?? 100), target = Number(process.argv[3] ?? 51000), TICKETS = Number(process.argv[4] ?? 8)
const MIN_ODDS = Number(process.env.MIN_ODDS ?? 1.8), MAX_LEGS = Number(process.env.MAX_LEGS ?? 16)   // the odds band the bot really uses; a hard leg cap
const need = target / stake

async function main() {
  const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
  const games = (await sportybet.fetchSelectionGames!({ dateFrom: d(0), dateTo: d(1), scanLimit: 250, minKickoffGapMinutes: 90 })).games
  const panel = await loadPanel(games)
  for (const g of games) for (const s of g.selections) { const c = consensus(panel.games.get(g.fixtureId), s.rule); if (c) s.sharp = c }
  const plan = await fetchSportyBonusPlan()
  const fairP = (s: Selection) => s.sharp && s.sharp.n >= 2 && s.sharp.spread <= 0.04 ? s.sharp.p : (s.probability ?? 1 / (s.odds * 1.06))
  const bookP = (s: Selection) => s.probability ?? 1 / (s.odds * 1.06)

  type Leg = { fid: number; s: Selection; fair: number; value: number; tour?: string }
  // each game's single best-value leg in the allowed odds range
  const best: Leg[] = []
  for (const g of games) {
    const legs = g.selections.filter(s => s.odds >= MIN_ODDS && s.odds <= 3.5).map(s => ({ fid: g.fixtureId, s, fair: fairP(s), value: s.odds * fairP(s), tour: g.tournamentId }))
    legs.sort((a, b) => b.value - a.value)
    if (legs[0]) best.push(legs[0])
  }
  best.sort((a, b) => b.value - a.value)
  console.log(`legs priced ${MIN_ODDS}–3.5, at most ${MAX_LEGS} per ticket · ${games.length} games, ${best.length} usable · ₦${stake} → ₦${target} (${need.toFixed(0)}×) · ${TICKETS} tickets per product · best-leg value ${best[0]?.value.toFixed(3)}…${best.at(-1)?.value.toFixed(3)}`)

  const plainReturn = (ls: Leg[]) => ls.reduce((x, l) => x * l.s.odds, 1) + sportyBonus(ls.map(l => ({ odds: l.s.odds, probability: l.s.probability, margin: l.s.margin, tournamentId: l.tour })), plan).perStake
  const products: { name: string; build: (pool: Leg[]) => { legs: Leg[]; ret: number; p: number } | null }[] = [
    { name: 'plain accumulator (+bonus)', build: pool => {
      const ls: Leg[] = []
      for (const l of pool) { ls.push(l); if (plainReturn(ls) >= need) return { legs: ls, ret: plainReturn(ls), p: ls.reduce((x, y) => x * y.fair, 1) }; if (ls.length >= MAX_LEGS) break }
      return null } },
    ...[1, 2].map(miss => ({ name: `Flexi ${miss === 1 ? 'N−1' : 'N−2'} of N`, build: (pool: Leg[]) => {
      const ls: Leg[] = []
      for (const l of pool) {
        ls.push(l)
        if (ls.length <= miss + 1) continue
        const fo = flexiOdds(ls.map(x => ({ odds: x.s.odds, probability: bookP(x.s) })), ls.length - miss)
        if (fo.odds >= need) return { legs: ls, ret: fo.odds, p: atLeast(correctDist(ls.map(x => x.fair)), ls.length - miss) }
        if (ls.length >= MAX_LEGS) break
      }
      return null } })),
  ]

  for (const prod of products) {
    let pool = [...best]
    const rows: { n: number; ret: number; p: number; keep: number }[] = []
    for (let t = 0; t < TICKETS; t++) {
      const r = prod.build(pool)
      if (!r) break
      rows.push({ n: r.legs.length, ret: r.ret, p: r.p, keep: r.p * r.ret })
      const used = new Set(r.legs.map(l => l.fid)); pool = pool.filter(l => !used.has(l.fid))
    }
    if (!rows.length) { console.log(`${prod.name.padEnd(28)} could not reach the target`); continue }
    const avg = (f: (r: typeof rows[number]) => number) => rows.reduce((x, r) => x + f(r), 0) / rows.length
    console.log(`${prod.name.padEnd(28)} tickets ${rows.length} · legs ${avg(r => r.n).toFixed(1)} · pays ×${avg(r => r.ret).toFixed(0)} · chance each ${(100 * avg(r => r.p)).toFixed(3)}% · keep ${avg(r => r.keep).toFixed(3)} (first ticket ${rows[0].keep.toFixed(3)}, last ${rows.at(-1)!.keep.toFixed(3)})`)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
// Result 2026-10-04 (73 games, ₦100 → ₦51k): plain keep 0.745 (8.5 legs) vs Flexi N−1 0.706 (12 legs) and
// N−2 0.723 (14.6 legs); with legs 2.2–3.5: plain 0.752 vs 0.632 / 0.650. Flexi at the target is WORSE: no
// Multi Bet Bonus, and the tolerance is priced in, so it needs 40–70% more legs (fewer disjoint tickets).

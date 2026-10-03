// Bench: does a leg-odds cap and/or per-game COVERAGE build a better family? Same live board, same money,
// all four variants scored the same way — at fair (panel) prices, with the survivors simulator:
//   chance of ≥1 win · games at least one slip survives with ≥90% · slips expected alive halfway · keep
//   npx tsx --env-file=.env --conditions=react-server scripts/bench-cover.ts [budget] [stake] [target]
import { sportybet } from '../lib/books/sportybet'
import { runDecisionBotAsync, type BotResult } from '../lib/pedlas/decision-bot'
import { fetchSportyBonusPlan, sportyBonus } from '../lib/books/sportybet-bonus'
import { loadPanel } from '../lib/books/panel'
import { consensus } from '../lib/books/reference'
import { analyzeCoverage, type CovGame, type CovSlip } from '../lib/pedlas/survivors'
import type { Selection } from '../lib/pedlas/selections'

const budget = Number(process.argv[2] ?? 2200), stake = Number(process.argv[3] ?? 100), target = Number(process.argv[4] ?? 51000)
const VARIANTS: { name: string; maxLegOdds?: number; coverWeight?: number }[] = [
  { name: 'old (no cap, no coverage)', maxLegOdds: Infinity, coverWeight: 0 },
  { name: 'cap 3.5', maxLegOdds: 3.5, coverWeight: 0 },
  { name: 'coverage', maxLegOdds: Infinity, coverWeight: 3 },
  { name: 'cap 3.5 + coverage', maxLegOdds: 3.5, coverWeight: 3 },
]

async function main() {
  const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
  const games = (await sportybet.fetchSelectionGames!({ dateFrom: d(0), dateTo: d(1), scanLimit: 250, minKickoffGapMinutes: 90 })).games
  const panel = await loadPanel(games)
  for (const g of games) for (const s of g.selections) { const c = consensus(panel.games.get(g.fixtureId), s.rule); if (c) s.sharp = c }
  const plan = await fetchSportyBonusPlan()
  const tour = new Map(games.flatMap(g => g.selections.map(s => [s, g.tournamentId] as const)))
  const bonusFn = (sels: Selection[]) => sportyBonus(sels.map(x => ({ odds: x.odds, probability: x.probability, margin: x.margin, tournamentId: tour.get(x) })), plan).perStake
  const fairP = (s: Selection) => s.sharp && s.sharp.n >= 2 && s.sharp.spread <= 0.04 ? s.sharp.p : (s.probability ?? 1 / (s.odds * 1.06))
  console.log(`${games.length} games · ₦${budget} as ₦${stake} slips → ₦${target} · skip, max 8 legs · panel ${panel.sources.map(s => `${s.source} ${s.matched}`).join(', ')}`)
  const rows: string[] = []
  for (const v of VARIANTS) {
    const t0 = Date.now()
    const r: BotResult = await runDecisionBotAsync(games, { stake, target, budget, rule: 'greedy', seed: 21, bonusFn, boost: sportybet.boostFor, maxPayout: sportybet.maxPayout, skip: true, maxLegs: 8, deadlineMs: 15 * 60_000, legProb: 'panel', maxLegOdds: v.maxLegOdds, coverWeight: v.coverWeight })
    const covGames: CovGame[] = r.games.map(g => ({ fixtureId: g.fixtureId, game: g.game, kickoff: g.kickoff, state: { kind: 'pending' } }))
    const covSlips: CovSlip[] = r.slips.map(s => ({ key: String(s.slipId), slipId: s.slipId, stake, payout: s.payout, legs: s.legs.map(l => ({ fixtureId: r.games[l.game].fixtureId, rule: l.selection.rule, name: l.selection.name, p: fairP(l.selection) })) }))
    const cov = analyzeCoverage(covGames, covSlips, { days: 20000, stake, target })
    const j = cov.plan.journey, half = j[Math.floor(j.length / 2)]
    const legs = r.slips.flatMap(s => s.legs)
    const odds = legs.map(l => l.selection.odds)
    const row = `${v.name.padEnd(20)} slips ${String(r.slips.length).padStart(2)} · win chance ${(100 * cov.plan.pAnyWin).toFixed(2)}% · keep ${cov.plan.keep.toFixed(3)} · survives ≥90% through ${cov.plan.survivalDepth90}/${j.length} games · alive halfway ${half ? half.expectedAliveAfter.toFixed(1) : '—'} · legs ${legs.length}, odds ${Math.min(...odds).toFixed(2)}–${Math.max(...odds).toFixed(2)}, ≥6: ${odds.filter(o => o >= 6).length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`
    console.log(row); rows.push(row)
  }
  console.log('\nSUMMARY\n' + rows.join('\n'))
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

// Bench the Decision Bot's leg ratings on the LIVE board — same games, same settings, scored honestly:
//   model — the old scoreline-model ratings (pre-2026-10-02)
//   book  — SportyBet's own fair probability (+ the low-margin value generator)
//   panel — the reference-panel consensus where Pinnacle + Kambi agree, else the book (+ value generator)
// Every family is scored at SportyBet's own prices AND at the panel's prices (the sharper estimate).
//   npx tsx --conditions=react-server scripts/bench-legprob.ts [budget] [target] [modes]
import { sportybet } from '../lib/books/sportybet'
import { runDecisionBotAsync, type BotResult } from '../lib/pedlas/decision-bot'
import { fetchSportyBonusPlan, sportyBonus } from '../lib/books/sportybet-bonus'
import { devigged } from '../lib/pedlas/scoreline-table'
import { loadPanel } from '../lib/books/panel'
import { consensus } from '../lib/books/reference'
import type { Selection } from '../lib/pedlas/selections'

const budget = Number(process.argv[2] ?? 500), target = Number(process.argv[3] ?? 51000)
const modes = (process.argv[4] ?? 'model,book,panel').split(',') as ('model' | 'book' | 'panel')[]
async function main() {
  const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
  const games = (await sportybet.fetchSelectionGames!({ dateFrom: d(0), dateTo: d(1), scanLimit: 250, minKickoffGapMinutes: 60 })).games
  const panel = await loadPanel(games)
  for (const g of games) for (const s of g.selections) { const c = consensus(panel.games.get(g.fixtureId), s.rule); if (c) s.sharp = c }
  const plan = await fetchSportyBonusPlan()
  const tour = new Map(games.flatMap(g => g.selections.map(s => [s, g.tournamentId] as const)))
  const bonusFn = (sels: Selection[]) => sportyBonus(sels.map(x => ({ odds: x.odds, probability: x.probability, margin: x.margin, tournamentId: tour.get(x) })), plan).perStake
  const bookP = (r: BotResult, gi: number, s: Selection) => s.probability != null && s.probability > 0 && s.probability < 1 ? s.probability : devigged(s, r.games[gi].selections)
  const panelP = (r: BotResult, gi: number, s: Selection) => s.sharp && s.sharp.n >= 2 && s.sharp.spread <= 0.04 ? s.sharp.p : bookP(r, gi, s)
  console.log(`${games.length} games · panel: ${panel.sources.map(s => `${s.source} ${s.matched} matched`).join(', ')} · ₦${budget} → ₦${target} · skip, max 8 legs · bonus plan ${plan.planName}`)
  for (const legProb of modes) {
    const t0 = Date.now()
    const r = await runDecisionBotAsync(games, { stake: 10, target, budget, rule: 'greedy', seed: 7, bonusFn, boost: sportybet.boostFor, maxPayout: sportybet.maxPayout, skip: true, maxLegs: 8, deadlineMs: 20 * 60_000, legProb })
    const staked = r.slips.length * 10
    const score = (pf: (r: BotResult, gi: number, s: Selection) => number) => {
      const p = r.slips.map(s => s.legs.reduce((x, l) => x * pf(r, l.game, l.selection), 1))
      return { sum: p.reduce((a, b) => a + b, 0), keep: r.slips.reduce((x, s, i) => x + p[i] * s.payout, 0) / staked }
    }
    const B = score(bookP), P = score(panelP)
    const legs = r.slips.flatMap(s => s.legs)
    console.log(`\n${legProb.toUpperCase()}: ${r.slips.length} slips in ${((Date.now() - t0) / 1000).toFixed(0)}s · bot's own headline ${(100 * r.pAnyWin).toFixed(2)}%`)
    console.log(`  at SportyBet's prices: Σ P(win) ${(100 * B.sum).toFixed(2)}% · keep ${B.keep.toFixed(3)}`)
    console.log(`  at the panel's prices: Σ P(win) ${(100 * P.sum).toFixed(2)}% · keep ${P.keep.toFixed(3)}`)
    console.log(`  legs ${legs.length} · avg odds×P(book) ${(legs.reduce((x, l) => x + l.selection.odds * bookP(r, l.game, l.selection), 0) / legs.length).toFixed(3)} · long shots (≥10) ${legs.filter(l => l.selection.odds >= 10).length} · low-margin picks chosen ${legs.filter(l => /low-margin/.test(l.why)).length}`)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

// Sweep the Decision Bot's levers on LIVE SportyBet selections (read-only; nothing placed):
// max legs per slip × target × market set, at one budget. Answers "what raises P(≥1 win) for real?"
//   JITI_ALIAS='{"server-only":"<repo>/test-stubs/server-only.ts"}' node node_modules/jiti/lib/jiti-cli.mjs scripts/bench-sweep.ts [budget] [targets] [maxLegs] [stakes]
// e.g. ... scripts/bench-sweep.ts 2000 51000 5,6,8,40      (FRESH=1 refetches games; SKIP=1 lets slips skip games)
// Stake per slip sets the slip COUNT (budget/stake): at a fixed target, a bigger stake needs lower odds →
// fewer legs → less compounded margin → higher keep → higher P(>=1), since P(>=1) <= keep*budget/target.
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { sportybet } from '../lib/books/sportybet'
import { runDecisionBot } from '../lib/pedlas/decision-bot'
import type { SelectionGame, Selection } from '../lib/pedlas/selections'
import { fetchSportyBonusPlan, sportyBonus } from '../lib/books/sportybet-bonus'

const budget = Number(process.argv[2] ?? 2000)
const targets = (process.argv[3] ?? '25000,51000,102000').split(',').map(Number)
const maxLegsList = (process.argv[4] ?? '5,6,7,8,10,40').split(',').map(Number)
const stakes = (process.argv[5] ?? '10').split(',').map(Number)
const markets = (process.env.MARKETS ?? 'all,noCS').split(',')
const CLEAN_SHEETS = new Set(['31', '32'])   // the two highest-margin markets in the S-A1FA6F data (keep ~0.92/leg)
const cache = `${process.env.TEMP ?? '.'}/pedla-bench-selections.json`

async function main() {
  let games: SelectionGame[]
  if (existsSync(cache) && process.env.FRESH !== '1') games = JSON.parse(readFileSync(cache, 'utf8'))
  else {
    const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
    games = (await sportybet.fetchSelectionGames!({ dateFrom: d(0), dateTo: d(1), scanLimit: 250, minKickoffGapMinutes: 60 })).games
    writeFileSync(cache, JSON.stringify(games))
  }
  const noCS = games.map(g => ({ ...g, selections: g.selections.filter(s => !CLEAN_SHEETS.has(String(s.marketId))) }))
  const plan = await fetchSportyBonusPlan()
  const bonusFn = (sels: Selection[]) => sportyBonus(sels.map(x => ({ odds: x.odds, probability: x.probability, margin: x.margin })), plan).perStake
  console.log(`games ${games.length} · budget ₦${budget} · bonus plan ${plan.planName} · skip ${process.env.SKIP === '1' ? 'ON' : 'off'}`)
  console.log('stake  target   markets   maxLegs  slips  legs   P(>=1)   ceiling  keep   E[net]')
  const sets = ([['all', games], ['noCS', noCS]] as const).filter(([l]) => markets.includes(l))
  for (const stake of stakes) for (const target of targets) for (const [label, gs] of sets) for (const maxLegs of maxLegsList) {
    const r = runDecisionBot(gs, { stake, target, budget, rule: 'greedy', seed: 7, boost: sportybet.boostFor, bonusFn, maxPayout: sportybet.maxPayout, maxLegs, skip: process.env.SKIP === '1' })
    if (!r.slips.length) { console.log(`${String(stake).padEnd(6)} ${String(target).padEnd(8)} ${label.padEnd(9)} ${String(maxLegs).padEnd(8)} —  no slip reaches the band`); continue }
    const legs = r.slips.map(s => s.legs.length)
    console.log(`${String(stake).padEnd(6)} ${String(target).padEnd(8)} ${label.padEnd(9)} ${String(maxLegs).padEnd(8)} ${String(r.slips.length).padEnd(6)} ${`${Math.min(...legs)}-${Math.max(...legs)}`.padEnd(6)} ${(100 * r.pAnyWin).toFixed(3).padStart(6)}%  ${(100 * r.ceiling).toFixed(3).padStart(6)}%  ${r.keepRate.toFixed(3)}  ₦${r.expectedNet}`)
  }
}
main()

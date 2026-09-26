// Benchmark the Decision Bot on LIVE SportyBet selections (read-only; nothing placed). Run:
//   JITI_ALIAS='{"server-only":"<repo>/test-stubs/server-only.ts"}' node node_modules/jiti/lib/jiti-cli.mjs scripts/bench-bot.ts [budget] [target] [rules]
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { sportybet } from '../lib/books/sportybet'
import { runDecisionBot, type BotRule } from '../lib/pedlas/decision-bot'
import type { SelectionGame, Selection } from '../lib/pedlas/selections'
import { fetchSportyBonusPlan, sportyBonus } from '../lib/books/sportybet-bonus'

const budget = Number(process.argv[2] ?? 1000), target = Number(process.argv[3] ?? 100000)
const rules = (process.argv[4] ?? 'greedy,weighted,random,flip').split(',') as BotRule[]
const cache = `${process.env.TEMP ?? '.'}/pedla-bench-selections.json`
async function main() {
  let games: SelectionGame[]
  if (existsSync(cache) && process.env.FRESH !== '1') games = JSON.parse(readFileSync(cache, 'utf8'))
  else {
    const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
    games = (await sportybet.fetchSelectionGames!({ dateFrom: d(0), dateTo: d(1), scanLimit: 250, minKickoffGapMinutes: 60 })).games
    writeFileSync(cache, JSON.stringify(games))
  }
  console.log(`games ${games.length} · selections/game ~${Math.round(games.reduce((s, g) => s + g.selections.length, 0) / Math.max(1, games.length))} · ₦${budget} → ₦${target}`)
  const plan = await fetchSportyBonusPlan()
  const bonusFn = (sels: Selection[]) => sportyBonus(sels.map(x => ({ odds: x.odds, probability: x.probability, margin: x.margin })), plan).perStake
  console.log('bonus priced with live plan', plan.planName)
  for (const rule of rules) {
    const t0 = Date.now()
    const r = runDecisionBot(games, { stake: 10, target, budget, rule, seed: 7, boost: sportybet.boostFor, bonusFn, maxPayout: sportybet.maxPayout, allowSubMinLegs: process.env.SUBMIN !== '0' })
    const inBand = r.slips.filter(s => s.payout >= target && s.payout <= target * 1.01).length
    const legs = r.slips.map(s => s.legs.length)
    console.log(`${rule.padEnd(8)} slips ${r.slips.length} (in band ${inBand}) legs ${Math.min(...legs)}-${Math.max(...legs)} · P(≥1) ${(100 * r.pAnyWin).toFixed(3)}% · ceiling Σp ${(100 * r.ceiling).toFixed(3)}% · keep ${r.keepRate.toFixed(3)} · E[net] ₦${r.expectedNet} · bonus on ${r.slips.filter(s => s.bonusApplies).length} · calib err ${(100 * r.calibrationMaxError).toFixed(2)}pt · ${Date.now() - t0}ms`); console.log("   ", r.notes.join(" | "))
    if (process.env.SHOW) for (const s of r.slips.slice(0, 2)) { console.log(`  slip ${s.slipId}: ₦${s.payout} · ${s.why}`); for (const l of s.legs) console.log(`    ${l.selection.name} @${l.selection.odds} — ${l.why}`) }
  }
}
main()

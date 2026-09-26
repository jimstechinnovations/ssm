// Benchmark the multi-market engine on LIVE SportyBet odds (no placement). Run:
//   node --conditions=react-server node_modules/jiti/lib/jiti-cli.mjs scripts/bench-multi.ts [budget] [target]
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { sportybet } from '../lib/books/sportybet'
import { buildMultiAxes, buildMultiBook } from '../lib/pedlas/multi-market'

const budget = Number(process.argv[2] ?? 5000), target = Number(process.argv[3] ?? 500000)
const cache = process.env.TEMP ? `${process.env.TEMP}/pedla-bench-fixtures.json` : "scripts/.bench-fixtures.json"
async function main() {
  let fixtures
  if (existsSync(cache) && process.env.FRESH !== '1') fixtures = JSON.parse(readFileSync(cache, 'utf8'))
  else {
    const today = new Date().toISOString().slice(0, 10)
    const to = new Date(Date.now() + 864e5).toISOString().slice(0, 10)
    fixtures = (await sportybet.fetchFixtures({ dateFrom: today, dateTo: to, scanLimit: 250, minKickoffGapMinutes: 60 })).fixtures
    writeFileSync(cache, JSON.stringify(fixtures))
  }
  const axes = buildMultiAxes(fixtures)
  console.log(`fixtures ${fixtures.length} · 3-band axes ${axes.length} · budget ₦${budget} · target ₦${target}`)
  for (const select of (process.env.MODES ?? 'sampled').split(',')) {
    const t0 = Date.now()
    const b = buildMultiBook(axes, { budget, stake: 10, target, maxPayout: 2e8, boost: sportybet.boostFor, select: select.replace(/@.*/, '') as 'greedy' | 'sampled', ...(select.includes('@') ? { rho: Number(select.split('@')[1]) } : {}) })
    const legs = b.slips.map(s => s.legs)
    console.log(`${select.padEnd(8)} slips ${b.K} N ${b.N} legs ${Math.min(...legs)}-${Math.max(...legs)} · P(≥1 win) ${(100 * b.pAnyWin).toFixed(2)}% · keep ${b.keepRate} · E[net] ₦${b.expectedNet} · ${Date.now() - t0}ms`)
    console.log(`   correlated stress P(≥1)=${(100 * b.pAnyWinCorrelated).toFixed(2)}% (ρ=${b.rhoStress})`)
  }
}
main()

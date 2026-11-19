import { readFileSync, writeFileSync } from 'node:fs'
const pool = JSON.parse(readFileSync('.bb1020-pool.json', 'utf8'))
const picks = []
for (const g of pool) {
  let best = null
  for (const m of g.markets) {
    if (m.id !== '225' || m.status !== 0) continue
    for (const o of m.outcomes || []) {
      if (!o.isActive) continue
      const prob = parseFloat(o.probability), odds = parseFloat(o.odds)
      if (odds < 1.08) continue
      if (!best || prob > best.prob) best = { label: o.desc, odds, prob, specifier: m.specifier, outcomeId: o.id }
    }
  }
  if (best) picks.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId: '225', specifier: best.specifier, outcomeId: best.outcomeId, label: best.label, odds: best.odds, prob: best.prob })
}
picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.bb1020-picks.json', JSON.stringify(picks, null, 2))
console.log('total picks:', picks.length)
let c = 1
for (const p of picks) c *= p.odds
console.log('max achievable odds if ALL used:', c.toFixed(2))
picks.slice(0, 25).forEach((p,i) => console.log(i+1, p.game, '|', p.league, '|', p.label, '@', p.odds, '| prob', p.prob.toFixed(3)))

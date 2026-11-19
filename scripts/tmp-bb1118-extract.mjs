import { readFileSync, writeFileSync } from 'node:fs'
const pool = JSON.parse(readFileSync('.bb1118-pool.json', 'utf8'))
const picks = []
for (const g of pool) {
  let best = null
  for (const m of g.markets) {
    if (m.id !== '225' || m.status !== 0) continue
    for (const o of m.outcomes || []) {
      if (!o.isActive) continue
      const prob = parseFloat(o.probability), odds = parseFloat(o.odds)
      if (odds < 1.05) continue
      if (!best || prob > best.prob) best = { label: o.desc, odds, prob, specifier: m.specifier, outcomeId: o.id }
    }
  }
  if (best && best.prob >= 0.70) picks.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId: '225', specifier: best.specifier, outcomeId: best.outcomeId, label: best.label, odds: best.odds, prob: best.prob })
}
picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.bb1118-picks.json', JSON.stringify(picks, null, 2))
console.log('qualifying picks (prob>=70%):', picks.length, 'of', pool.length)
for (const p of picks.slice(0, 25)) console.log(p.game.padEnd(40), p.league.padEnd(22), p.label.padEnd(10), p.odds, (p.prob*100).toFixed(1)+'%')

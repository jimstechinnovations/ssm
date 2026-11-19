import { readFileSync, writeFileSync } from 'node:fs'
const pool = JSON.parse(readFileSync('.bball5-pool.json', 'utf8'))
const picks = []
for (const g of pool) {
  let best = null
  for (const m of g.markets) {
    if (m.id !== '225' || m.status !== 0) continue
    for (const o of m.outcomes || []) {
      if (!o.isActive) continue
      const prob = parseFloat(o.probability)
      const odds = parseFloat(o.odds)
      if (odds < 1.08) continue // too thin to matter
      if (!best || prob > best.prob) best = { label: o.desc, odds, prob, specifier: m.specifier, outcomeId: o.id }
    }
  }
  if (best) picks.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId: '225', specifier: best.specifier, outcomeId: best.outcomeId, label: best.label, odds: best.odds, prob: best.prob })
}
picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.bball5-picks.json', JSON.stringify(picks, null, 2))
console.log('picks', picks.length)
for (const p of picks.slice(0, 15)) console.log(p.game, '|', p.league, '|', p.label, '@', p.odds, '(' + (p.prob*100).toFixed(1) + '%)', '|', new Date(p.kickoff).toISOString())

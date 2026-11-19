import { readFileSync, writeFileSync } from 'node:fs'
const pool = JSON.parse(readFileSync('.fbunder-pool.json', 'utf8'))
const picks = []
for (const g of pool) {
  const m = g.markets.find(x => x.id === '18' && x.specifier === 'total=3.5' && x.status === 0)
  if (!m) continue
  for (const o of m.outcomes || []) {
    if (!o.isActive) continue
    if (o.desc !== 'Under 3.5') continue
    const odds = parseFloat(o.odds), prob = parseFloat(o.probability)
    picks.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId: '18', specifier: 'total=3.5', outcomeId: o.id, label: o.desc, odds, prob })
  }
}
picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.fbunder-picks.json', JSON.stringify(picks, null, 2))
console.log('picks', picks.length)
for (const p of picks) console.log(p.game, '|', p.league, '|', p.label, '@', p.odds, '(' + (p.prob*100).toFixed(1) + '%)', '|', new Date(p.kickoff).toISOString())

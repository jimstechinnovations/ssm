import { readFileSync, writeFileSync } from 'node:fs'
const pool = JSON.parse(readFileSync('.fbtoday-pool.json', 'utf8'))
const picks = []
for (const g of pool) {
  const m = g.markets.find(x => x.id === '18' && x.specifier === 'total=1.5' && x.status === 0)
  if (!m) continue
  for (const o of m.outcomes || []) {
    if (!o.isActive) continue
    if (o.desc !== 'Over 1.5') continue // goals market preference per standing rule: Over, not DC, not straight win
    const odds = parseFloat(o.odds), prob = parseFloat(o.probability)
    if (odds < 1.05) continue
    picks.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId: '18', specifier: 'total=1.5', outcomeId: o.id, label: o.desc, odds, prob })
  }
}
picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.fbtoday-picks.json', JSON.stringify(picks, null, 2))
console.log('picks', picks.length)
for (const p of picks.slice(0, 15)) console.log(p.game, '|', p.league, '|', p.label, '@', p.odds, '(' + (p.prob*100).toFixed(1) + '%)', '|', new Date(p.kickoff).toISOString())

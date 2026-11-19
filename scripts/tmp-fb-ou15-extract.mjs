import { readFileSync, writeFileSync } from 'node:fs'
const pool = JSON.parse(readFileSync('.fb-ou-pool.json', 'utf8'))
const picks = []
for (const g of pool) {
  const m = g.markets.find(x => x.id === '18' && x.specifier === 'total=1.5')
  if (!m || m.status !== 0) continue
  const over = (m.outcomes || []).find(o => o.desc === 'Over 1.5' && o.isActive === 1)
  if (!over) continue
  picks.push({
    fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff,
    label: over.desc, odds: +over.odds, prob: +over.probability,
    marketId: '18', specifier: 'total=1.5', outcomeId: over.id,
  })
}
picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.fb-ou15-picks.json', JSON.stringify(picks))
console.log('total Over1.5 picks:', picks.length)
for (const p of picks.slice(0, 10)) console.log(' ', p.prob.toFixed(3), p.odds, p.game, p.league)

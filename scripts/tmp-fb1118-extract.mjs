import { readFileSync, writeFileSync } from 'node:fs'

const RISKY_LEAGUE_RE = /^J2 League$|^J3 League$|Serie C|Eerste Divisie|Liga de Expansion|^Ettan$|A-League, Women|Eredivisie, Women|Super League( 2)?, Women|Tercera Federacion|Promotion d.Honneur|^2\. Liga$|Primera Division, Women|Premier League, Women|U20|U19|U21|Reserves?|Premier League Cup/

const pool = JSON.parse(readFileSync('.fb1118-pool.json', 'utf8'))
const picks = []
for (const g of pool) {
  if (RISKY_LEAGUE_RE.test(g.league)) continue
  const over = g.markets.find(x => x.id === '18' && x.specifier === 'total=1.5' && x.status === 0)
  const under = g.markets.find(x => x.id === '18' && x.specifier === 'total=3.5' && x.status === 0)
  const oOver = over && (over.outcomes || []).find(o => o.desc === 'Over 1.5' && o.isActive)
  const oUnder = under && (under.outcomes || []).find(o => o.desc === 'Under 3.5' && o.isActive)
  let best = null
  if (oOver) best = { label: 'Over 1.5', odds: parseFloat(oOver.odds), prob: parseFloat(oOver.probability), outcomeId: oOver.id, specifier: 'total=1.5' }
  if (oUnder) {
    const u = { label: 'Under 3.5', odds: parseFloat(oUnder.odds), prob: parseFloat(oUnder.probability), outcomeId: oUnder.id, specifier: 'total=3.5' }
    if (!best || u.prob > best.prob) best = u
  }
  if (!best) continue
  if (best.odds < 1.05 || best.prob < 0.55) continue
  picks.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId: '18', specifier: best.specifier, outcomeId: best.outcomeId, label: best.label, odds: best.odds, prob: best.prob })
}
picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.fb1118-picks.json', JSON.stringify(picks, null, 2))
console.log('qualifying picks:', picks.length, 'out of', pool.length)
for (const p of picks) console.log(p.game.padEnd(40), p.league.padEnd(25), p.label.padEnd(10), p.odds, (p.prob*100).toFixed(1)+'%')

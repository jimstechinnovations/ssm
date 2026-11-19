import { readFileSync, writeFileSync } from 'node:fs'

const RISKY_LEAGUE_RE = /^J2 League$|^J3 League$|Serie C|Eerste Divisie|Liga de Expansion|^Ettan$|A-League, Women|Eredivisie, Women|Super League( 2)?, Women|Tercera Federacion|Promotion d.Honneur|^2\. Liga$|Primera Division, Women|Premier League, Women|U20|U19/

const pool = JSON.parse(readFileSync('.5102-fbpool.json', 'utf8'))
const picks = []
for (const g of pool) {
  if (RISKY_LEAGUE_RE.test(g.league)) continue
  const m = g.markets.find(x => x.id === '18' && x.specifier === 'total=1.5' && x.status === 0)
  if (!m) continue
  for (const o of m.outcomes || []) {
    if (!o.isActive || o.desc !== 'Over 1.5') continue
    const odds = parseFloat(o.odds), prob = parseFloat(o.probability)
    if (odds < 1.05) continue
    picks.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId: '18', specifier: 'total=1.5', outcomeId: o.id, label: o.desc, odds, prob })
  }
}
picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.5102-picks.json', JSON.stringify(picks, null, 2))
console.log('total picks:', picks.length)
let c = 1
for (const p of picks) c *= p.odds
console.log('max achievable odds if ALL used:', c.toFixed(2))
console.log('\nUEFA/AFCON picks in pool:')
for (const p of picks) if (/Nations League|UEFA|AFCON|Africa Cup|African Nations/i.test(p.league)) {
  console.log(' ', p.game, '|', p.league, '| odds', p.odds, '| prob', p.prob)
}

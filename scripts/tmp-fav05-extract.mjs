import { readFileSync, writeFileSync } from 'node:fs'

const RISKY_LEAGUE_RE = /^J2 League$|^J3 League$|Serie C|Eerste Divisie|Liga de Expansion|^Ettan$|A-League, Women|Eredivisie, Women|Super League( 2)?, Women|Tercera Federacion|Promotion d.Honneur|^2\. Liga$|Primera Division, Women|Premier League, Women|U20|U19|Reserves|Premier League Cup/

const pool = JSON.parse(readFileSync('.fb1117-pool.json', 'utf8'))
const picks = []

for (const g of pool) {
  if (RISKY_LEAGUE_RE.test(g.league)) continue
  const m1 = g.markets.find(x => x.id === '1' && x.status === 0)
  if (!m1) continue
  const home1x2 = (m1.outcomes || []).find(o => o.desc === 'Home')
  const away1x2 = (m1.outcomes || []).find(o => o.desc === 'Away')
  if (!home1x2 || !away1x2) continue
  const hOdds = parseFloat(home1x2.odds), aOdds = parseFloat(away1x2.odds)

  // determine the moneyline favorite (whichever side is shorter odds), no cutoff
  let favSide = null, favOdds = null
  if (hOdds < aOdds) { favSide = 'home'; favOdds = hOdds }
  else if (aOdds < hOdds) { favSide = 'away'; favOdds = aOdds }
  if (!favSide) continue

  const marketId = favSide === 'home' ? '19' : '20'
  const mFav = g.markets.find(x => x.id === marketId && x.specifier === 'total=0.5' && x.status === 0)
  const favOver05 = mFav && (mFav.outcomes || []).find(o => o.desc === 'Over 0.5' && o.isActive)
  if (!favOver05) continue // favorite's own market not available — skip, don't fall back to the other side

  const odds = parseFloat(favOver05.odds), prob = parseFloat(favOver05.probability)
  if (odds < 1.02 || prob < 0.75) continue

  picks.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId, specifier: 'total=0.5', outcomeId: favOver05.id, label: (favSide === 'home' ? g.home : g.away) + ' Over 0.5', team: favSide === 'home' ? g.home : g.away, favSide, favOdds, odds, prob })
}

picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.fav05-picks.json', JSON.stringify(picks, null, 2))
console.log('total qualifying games:', picks.length)
let c = 1
for (const p of picks) c *= p.odds
console.log('combined odds if ALL used:', c.toFixed(2))
picks.forEach((p, i) => {
  const d = new Date(p.kickoff); d.setUTCHours(d.getUTCHours() + 2)
  console.log(i+1, d.toISOString().slice(0,16).replace('T',' '), 'CAT |', p.game.padEnd(40), '|', p.league.padEnd(32), '|', p.label, '@', p.odds, '| prob', p.prob.toFixed(3), '| fav moneyline', p.favOdds)
})

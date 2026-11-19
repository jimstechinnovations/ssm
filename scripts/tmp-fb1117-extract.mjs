import { readFileSync, writeFileSync } from 'node:fs'

const RISKY_LEAGUE_RE = /^J2 League$|^J3 League$|Serie C|Eerste Divisie|Liga de Expansion|^Ettan$|A-League, Women|Eredivisie, Women|Super League( 2)?, Women|Tercera Federacion|Promotion d.Honneur|^2\. Liga$|Primera Division, Women|Premier League, Women|U20|U19|Reserves|Premier League Cup/

const pool = JSON.parse(readFileSync('.fb1117-pool.json', 'utf8'))
const picks = []
let swapped = 0

for (const g of pool) {
  if (RISKY_LEAGUE_RE.test(g.league)) continue

  const m18 = g.markets.find(x => x.id === '18' && x.specifier === 'total=1.5' && x.status === 0)
  const m1 = g.markets.find(x => x.id === '1' && x.status === 0)
  if (!m18) continue
  const over15 = (m18.outcomes || []).find(o => o.desc === 'Over 1.5' && o.isActive)
  if (!over15) continue
  const odds15 = parseFloat(over15.odds), prob15 = parseFloat(over15.probability)
  if (odds15 < 1.05) continue

  // detect heavy favorite via 1X2
  let favSide = null, favOdds = null
  if (m1) {
    const home = (m1.outcomes || []).find(o => o.desc === 'Home')
    const away = (m1.outcomes || []).find(o => o.desc === 'Away')
    if (home && parseFloat(home.odds) < 1.35) { favSide = 'home'; favOdds = parseFloat(home.odds) }
    else if (away && parseFloat(away.odds) < 1.35) { favSide = 'away'; favOdds = parseFloat(away.odds) }
  }

  if (favSide) {
    const marketId = favSide === 'home' ? '19' : '20'
    const mFav = g.markets.find(x => x.id === marketId && x.specifier === 'total=0.5' && x.status === 0)
    const favOver05 = mFav && (mFav.outcomes || []).find(o => o.desc === 'Over 0.5' && o.isActive)
    if (favOver05) {
      const favOverOdds = parseFloat(favOver05.odds), favOverProb = parseFloat(favOver05.probability)
      // only swap if the team-over-0.5 pick is actually safer (higher prob) than match Over1.5
      if (favOverProb > prob15 && favOverOdds >= 1.03) {
        swapped++
        picks.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId, specifier: 'total=0.5', outcomeId: favOver05.id, label: (favSide === 'home' ? g.home : g.away) + ' Over 0.5', odds: favOverOdds, prob: favOverProb, swapped: true, favOdds })
        continue
      }
    }
  }
  picks.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId: '18', specifier: 'total=1.5', outcomeId: over15.id, label: 'Over 1.5', odds: odds15, prob: prob15, swapped: false })
}

picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.fb1117-picks.json', JSON.stringify(picks, null, 2))
console.log('total picks:', picks.length, '| swapped to team-Over0.5:', swapped)
let c = 1
for (const p of picks) c *= p.odds
console.log('max achievable odds if ALL used:', c.toFixed(2))
console.log('\nswapped legs (favorite Over 0.5 instead of match Over1.5):')
picks.filter(p => p.swapped).forEach(p => console.log(' ', p.game, '|', p.league, '|', p.label, '@', p.odds, '(fav odds', p.favOdds, ')'))

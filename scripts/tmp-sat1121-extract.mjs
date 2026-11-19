import { readFileSync, writeFileSync } from 'node:fs'

const RISKY_LEAGUE_RE = /^J2 League$|^J3 League$|Serie C|Eerste Divisie|Liga de Expansion|^Ettan$|A-League, Women|Eredivisie, Women|Super League( 2)?, Women|Tercera Federacion|Promotion d.Honneur|^2\. Liga$|Primera Division, Women|Premier League, Women|U20|U19|U21|Reserves?|Premier League Cup/

const pool = JSON.parse(readFileSync('.sat1121-pool.json', 'utf8'))
const picks = []
for (const g of pool) {
  if (RISKY_LEAGUE_RE.test(g.league)) continue

  // match-level Over 1.5
  const m18 = g.markets.find(x => x.id === '18' && x.specifier === 'total=1.5' && x.status === 0)
  const o18 = m18 && (m18.outcomes || []).find(o => o.desc === 'Over 1.5' && o.isActive)
  const matchOver = o18 ? { label: 'Over 1.5 (match)', odds: parseFloat(o18.odds), prob: parseFloat(o18.probability), outcomeId: o18.id, marketId: '18', specifier: 'total=1.5' } : null

  // favorite's own Over 0.5 (market 19 home / 20 away), favorite = shorter moneyline side
  const m1 = g.markets.find(x => x.id === '1' && x.status === 0)
  let favOver = null
  if (m1) {
    const h = (m1.outcomes || []).find(o => o.desc === 'Home'), a = (m1.outcomes || []).find(o => o.desc === 'Away')
    if (h && a) {
      const hOdds = parseFloat(h.odds), aOdds = parseFloat(a.odds)
      let favSide = hOdds < aOdds ? 'home' : (aOdds < hOdds ? 'away' : null)
      if (favSide) {
        const marketId = favSide === 'home' ? '19' : '20'
        const mFav = g.markets.find(x => x.id === marketId && x.specifier === 'total=0.5' && x.status === 0)
        const oFav = mFav && (mFav.outcomes || []).find(o => o.desc === 'Over 0.5' && o.isActive)
        if (oFav) favOver = { label: `Over 0.5 (${favSide === 'home' ? g.home : g.away})`, odds: parseFloat(oFav.odds), prob: parseFloat(oFav.probability), outcomeId: oFav.id, marketId, specifier: 'total=0.5' }
      }
    }
  }

  let best = null
  if (matchOver && matchOver.odds >= 1.05 && matchOver.prob >= 0.70) best = matchOver
  if (favOver && favOver.odds >= 1.05 && favOver.prob >= 0.75) {
    if (!best || favOver.prob > best.prob) best = favOver
  }
  if (!best) continue
  picks.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId: best.marketId, specifier: best.specifier, outcomeId: best.outcomeId, label: best.label, odds: best.odds, prob: best.prob })
}
picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.sat1121-picks.json', JSON.stringify(picks, null, 2))
console.log('total Saturday games in window:', pool.length)
console.log('qualifying mixed Over1.5/Over0.5 picks:', picks.length)
let maxOdds = 1
for (const p of picks) maxOdds *= p.odds
console.log('max achievable combined odds if ALL used:', maxOdds.toFixed(2))

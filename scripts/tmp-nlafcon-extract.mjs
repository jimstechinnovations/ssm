import { readFileSync, writeFileSync } from 'node:fs'
const games = JSON.parse(readFileSync('.nlafcon-detail.json', 'utf8'))

function findMarket(markets, id, specifier) {
  return markets.find(m => m.id === id && (specifier === undefined || m.specifier === specifier))
}

const rows = []
for (const g of games) {
  const m1 = findMarket(g.markets, '1')
  let favSide = null, favProb = 0, favOdds = null
  if (m1) {
    const home = m1.outcomes.find(o => o.desc === 'Home')
    const away = m1.outcomes.find(o => o.desc === 'Away')
    if (home && +home.probability > favProb) { favProb = +home.probability; favSide = 'Home'; favOdds = +home.odds }
    if (away && +away.probability > favProb) { favProb = +away.probability; favSide = 'Away'; favOdds = +away.odds }
  }
  const o15 = findMarket(g.markets, '18', 'total=1.5')
  const o25 = findMarket(g.markets, '18', 'total=2.5')
  const o15out = o15 && o15.outcomes.find(o => /Over/i.test(o.desc))
  const o25out = o25 && o25.outcomes.find(o => /Over/i.test(o.desc))

  const teamMarketId = favSide === 'Home' ? '19' : favSide === 'Away' ? '20' : null
  const tm = teamMarketId ? findMarket(g.markets, teamMarketId, 'total=0.5') : null
  const tmOut = tm && tm.outcomes.find(o => /Over/i.test(o.desc))

  rows.push({
    fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff,
    over15: o15out ? { odds: +o15out.odds, prob: +o15out.probability, outcomeId: o15out.id, specifier: 'total=1.5' } : null,
    over25: o25out ? { odds: +o25out.odds, prob: +o25out.probability, outcomeId: o25out.id, specifier: 'total=2.5' } : null,
    favTeam: favSide ? (favSide === 'Home' ? g.game.split(' vs ')[0] : g.game.split(' vs ')[1]) : null,
    favProb, favOdds,
    teamO05: tmOut ? { marketId: teamMarketId, odds: +tmOut.odds, prob: +tmOut.probability, outcomeId: tmOut.id, specifier: 'total=0.5' } : null,
  })
}
writeFileSync('.nlafcon-extract.json', JSON.stringify(rows, null, 2))
for (const r of rows) {
  const k = new Date(r.kickoff + 2*60*60*1000).toISOString().slice(11,16)
  console.log(k, r.game, '|', r.league.slice(0,4),
    '| O1.5', r.over15 ? r.over15.odds+'('+(r.over15.prob*100).toFixed(0)+'%)' : '-',
    '| O2.5', r.over25 ? r.over25.odds+'('+(r.over25.prob*100).toFixed(0)+'%)' : '-',
    '| fav', r.favTeam, r.favOdds, '| teamO0.5', r.teamO05 ? r.teamO05.odds+'('+(r.teamO05.prob*100).toFixed(0)+'%)' : '-')
}

import { readFileSync, writeFileSync } from 'node:fs'
const LIVE_OR_ENDED = ['Russia vs Venezuela','United Arab Emirates vs Syria','Guinea-Bissau vs Madagascar','Jordan vs Australia','Gambia vs Ivory Coast','Egypt vs Japan','Togo vs Algeria','Kenya vs South Africa']
const EXCL = new Set(['75802270','73601838','75445668','75801284','75556764','75597618','75555184','75556776','75802310','75802308','75439658','76438858','68932770','76169018'])
const pool = JSON.parse(readFileSync('.fav05-picks.json', 'utf8')).filter(p => !EXCL.has(p.fid) && !LIVE_OR_ENDED.includes(p.game))
const excluded = new Set()

function toLegs(arr) {
  return arr.map(l => ({ fid: l.fid, fixtureId: l.fid, game: l.game, league: l.league, kickoff: new Date(l.kickoff).toISOString(), outcome: l.label, odds: l.odds, prob: l.prob, rawMarketId: l.marketId, rawSpecifier: l.specifier || '', rawOutcomeId: l.outcomeId }))
}

for (let round = 1; round <= 8; round++) {
  const avail = pool.filter(p => !excluded.has(p.fid))
  const legs = toLegs(avail)
  writeFileSync('slip-fav05.json', JSON.stringify({ legs }, null, 2))
  let odds = 1
  for (const l of legs) odds *= l.odds
  console.log(`\nROUND ${round}: slip = ${legs.length} legs (ALL), odds ${odds.toFixed(2)}`)
  const sels = legs.map(l => ({ eventId: 'sr:match:' + l.fixtureId, marketId: l.rawMarketId, specifier: l.rawSpecifier, outcomeId: l.rawOutcomeId }))
  const r = await fetch('https://www.sportybet.com/api/ng/orders/share', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ selections: sels, shareType: 1 }) })
  const j = await r.json()
  console.log('bizCode', j.bizCode, 'code', j.data?.shareCode)
  let newBad = 0
  for (const o of j.data?.outcomes || []) {
    if (o.bookingStatus !== 'Booked') {
      const leg = legs.find(l => l.game === (o.homeTeamName + ' vs ' + o.awayTeamName))
      if (leg && !excluded.has(leg.fid)) { excluded.add(leg.fid); newBad++; console.log('  excluding:', leg.game) }
    }
  }
  console.log('newly excluded:', newBad)
  if (newBad === 0) { console.log('CLEAN — slip-fav05.json ready'); break }
}

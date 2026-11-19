import { readFileSync, writeFileSync } from 'node:fs'
const BAD = new Set(['75802244','76779688','76593094','75468292'])
const UNAVAIL_INTL = /Canada vs Guatemala|Martinique vs Aruba|Trinidad and Tobago|Malaysia vs Yemen/
const pool = JSON.parse(readFileSync('.5102-final10-picks.json', 'utf8')).filter(p => !BAD.has(p.fid) && !UNAVAIL_INTL.test(p.game))

function toLegs(arr) {
  return arr.map(l => ({ fid: l.fid, fixtureId: l.fid, game: l.game, league: l.league, kickoff: new Date(l.kickoff).toISOString(), outcome: l.label, odds: l.odds, prob: l.prob, rawMarketId: l.marketId, rawSpecifier: l.specifier || '', rawOutcomeId: l.outcomeId }))
}

let c = 1
for (const p of pool) c *= p.odds
console.log('vetted+bookable legs:', pool.length, '| max achievable odds:', c.toFixed(2))

const excluded = new Set()
for (let round = 1; round <= 10; round++) {
  const avail = pool.filter(p => !excluded.has(p.fid))
  const legs = toLegs(avail)
  writeFileSync('slip-5102-100x.json', JSON.stringify({ legs }, null, 2))
  let odds = 1
  for (const l of legs) odds *= l.odds
  console.log(`\nROUND ${round}: slip = ${legs.length} legs (ALL remaining), odds ${odds.toFixed(2)}`)
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
  if (newBad === 0) { console.log('CLEAN — slip-5102-100x.json ready'); break }
}

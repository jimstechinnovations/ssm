import { readFileSync, writeFileSync } from 'node:fs'

let pool = JSON.parse(readFileSync('.long3000-merged.json', 'utf8'))
const excluded = new Set(["74063598","72305328","76617952","73018700","72597860","72305320","73018714","73095058","74827234","72500822","73346118"])
const TARGET = 3000

for (let round = 1; round <= 8; round++) {
  const avail = pool.filter(p => !excluded.has(p.fid))
  let c = 1, used = []
  for (const p of avail) {
    used.push(p); c *= p.odds
    if (c >= TARGET) break
  }
  const legs = used.map(l => ({ fid: l.fid, fixtureId: l.fid, game: l.game, league: l.league, kickoff: new Date(l.kickoff).toISOString(), outcome: l.label, odds: l.odds, prob: l.prob, rawMarketId: l.marketId, rawSpecifier: l.specifier, rawOutcomeId: l.outcomeId }))
  writeFileSync('slip-long3000.json', JSON.stringify({ legs }, null, 2))
  console.log(`\nROUND ${round}: ${legs.length} legs, odds ${c.toFixed(2)}`)

  const sels = legs.map(l => ({ eventId: 'sr:match:' + l.fixtureId, marketId: l.rawMarketId, specifier: l.rawSpecifier || '', outcomeId: l.rawOutcomeId }))
  const r = await fetch('https://www.sportybet.com/api/ng/orders/share', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ selections: sels, shareType: 1 }) })
  const j = await r.json()
  console.log('bizCode', j.bizCode, 'code', j.data?.shareCode)
  let newBad = 0
  for (const o of j.data?.outcomes || []) {
    if (o.bookingStatus !== 'Booked') {
      const leg = legs.find(l => l.game === (o.homeTeamName + ' vs ' + o.awayTeamName))
      if (leg && !excluded.has(leg.fid)) { excluded.add(leg.fid); newBad++ }
    }
  }
  console.log('newly excluded this round:', newBad, '(total excluded so far:', excluded.size, ')')
  if (newBad === 0) { console.log('CLEAN — stopping'); break }
}

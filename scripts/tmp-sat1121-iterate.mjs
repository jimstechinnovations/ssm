import { readFileSync, writeFileSync } from 'node:fs'
const TARGET = Number(process.argv[2] || 10)
const OUT = process.argv[3] || 'slip-sat1121-10x.json'
const pool = JSON.parse(readFileSync('.sat1121-picks.json', 'utf8'))

function toLegs(arr) {
  return arr.map(l => ({ fid: l.fid, fixtureId: l.fid, game: l.game, league: l.league, kickoff: new Date(l.kickoff).toISOString(), outcome: l.label, odds: l.odds, prob: l.prob, rawMarketId: l.marketId, rawSpecifier: l.specifier || '', rawOutcomeId: l.outcomeId }))
}

const excluded = new Set()
for (let round = 1; round <= 6; round++) {
  const avail = pool.filter(p => !excluded.has(p.fid))
  let c = 1, used = []
  for (const p of avail) { used.push(p); c *= p.odds; if (c >= TARGET) break }
  if (c < TARGET) { console.log('CANNOT REACH', TARGET, '— max legs:', avail.length, 'max odds:', c.toFixed(2)); break }
  const legs = toLegs(used)
  writeFileSync(OUT, JSON.stringify({ legs }, null, 2))
  console.log(`\nROUND ${round}: slip = ${legs.length} legs, odds ${c.toFixed(2)}`)
  const sels = legs.map(l => ({ eventId: 'sr:match:' + l.fixtureId, marketId: l.rawMarketId, specifier: l.rawSpecifier, outcomeId: l.rawOutcomeId }))
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
  console.log('newly excluded:', newBad)
  if (newBad === 0) { console.log('CLEAN —', OUT, 'ready'); break }
}

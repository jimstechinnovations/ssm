import { readFileSync, writeFileSync } from 'node:fs'
const pool = JSON.parse(readFileSync('.combo1000-picks.json', 'utf8'))
const excluded = new Set(process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : [])
const TARGET = 1000

function buildSlice(avail) {
  let c = 1, used = []
  for (const p of avail) {
    used.push(p); c *= p.odds
    if (c >= TARGET) return { legs: used, odds: c }
  }
  return null
}

function toLegs(arr) {
  return arr.map(l => ({ fid: l.fid, fixtureId: l.fid, sport: l.sport, game: l.game, league: l.league, kickoff: new Date(l.kickoff).toISOString(), outcome: l.label, odds: l.odds, prob: l.prob, rawMarketId: l.marketId, rawSpecifier: l.specifier || '', rawOutcomeId: l.outcomeId }))
}

for (let round = 1; round <= 15; round++) {
  const avail = pool.filter(p => !excluded.has(p.fid))
  const cut = buildSlice(avail)
  if (!cut) { console.log('CANNOT REACH 1000x — pool exhausted, max legs:', avail.length); break }
  const legs = toLegs(cut.legs)
  writeFileSync('slip-combo1000.json', JSON.stringify({ legs }, null, 2))
  console.log(`\nROUND ${round}: slip = ${legs.length} legs, odds ${cut.odds.toFixed(2)}`)

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
  console.log('newly excluded:', newBad, '(total excluded:', excluded.size, ')')
  if (newBad === 0) { console.log('CLEAN — slip-combo1000.json ready'); break }
}

import { readFileSync, writeFileSync } from 'node:fs'
const pool = JSON.parse(readFileSync('.bb1020-picks.json', 'utf8')).filter(p => !['74320764','73050294','74320766','72696340'].includes(p.fid))
const TARGETS = [10, 20]

function buildSlice(avail, target) {
  let c = 1, used = []
  for (const p of avail) {
    used.push(p); c *= p.odds
    if (c >= target) return { legs: used, odds: c }
  }
  return null
}
function toLegs(arr) {
  return arr.map(l => ({ fid: l.fid, fixtureId: l.fid, game: l.game, league: l.league, kickoff: new Date(l.kickoff).toISOString(), outcome: l.label, odds: l.odds, prob: l.prob, rawMarketId: l.marketId, rawSpecifier: l.specifier || '', rawOutcomeId: l.outcomeId }))
}

const excludedGlobal = new Set()
for (const target of TARGETS) {
  const localExcluded = new Set(excludedGlobal)
  for (let round = 1; round <= 10; round++) {
    const avail = pool.filter(p => !localExcluded.has(p.fid))
    const cut = buildSlice(avail, target)
    if (!cut) { console.log(`TARGET ${target}x: CANNOT REACH`); break }
    const legs = toLegs(cut.legs)
    const fname = `slip-bb1020-${target}x.json`
    writeFileSync(fname, JSON.stringify({ legs }, null, 2))
    console.log(`\nTARGET ${target}x ROUND ${round}: slip = ${legs.length} legs, odds ${cut.odds.toFixed(2)}`)
    const sels = legs.map(l => ({ eventId: 'sr:match:' + l.fixtureId, marketId: l.rawMarketId, specifier: l.rawSpecifier, outcomeId: l.rawOutcomeId }))
    const r = await fetch('https://www.sportybet.com/api/ng/orders/share', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ selections: sels, shareType: 1 }) })
    const j = await r.json()
    console.log('bizCode', j.bizCode, 'code', j.data?.shareCode)
    let newBad = 0
    for (const o of j.data?.outcomes || []) {
      if (o.bookingStatus !== 'Booked') {
        const leg = legs.find(l => l.game === (o.homeTeamName + ' vs ' + o.awayTeamName))
        if (leg && !localExcluded.has(leg.fid)) { localExcluded.add(leg.fid); newBad++; console.log('  excluding:', leg.game) }
      }
    }
    console.log('newly excluded:', newBad)
    if (newBad === 0) { console.log(`CLEAN — ${fname} ready`); break }
  }
}

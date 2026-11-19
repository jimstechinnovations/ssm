import { readFileSync, writeFileSync } from 'node:fs'
const pool = JSON.parse(readFileSync('.5102-picks.json', 'utf8')).filter(p => !['72477582', '75802244', '76646394', '76806620', '71936254', '76779688', '76593094'].includes(p.fid))
const excluded = new Set()
const TARGETS = [5]

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

for (const target of TARGETS) {
  const localExcluded = new Set(excluded)
  for (let round = 1; round <= 10; round++) {
    const avail = pool.filter(p => !localExcluded.has(p.fid))
    const cut = buildSlice(avail, target)
    if (!cut) { console.log(`TARGET ${target}x: CANNOT REACH — pool exhausted`); break }
    const legs = toLegs(cut.legs)
    const fname = `slip-5102-${target}x.json`
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

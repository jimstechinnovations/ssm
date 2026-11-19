import { readFileSync, writeFileSync } from 'node:fs'
const pool = JSON.parse(readFileSync('.fb-ou15-picks.json', 'utf8'))
const excluded = new Set(['74838480', '76676666']) // Scotland vs Kosovo (U19), Cucuta vs Jaguares de Cordoba - low recent scoring form, flagged
const TARGETS = [10, 20, 100]

function buildSlices(avail) {
  const cutLegs = { 10: null, 20: null, 100: null }
  let c = 1, used = []
  for (const p of avail) {
    used.push(p); c *= p.odds
    for (const t of TARGETS) if (!cutLegs[t] && c >= t) cutLegs[t] = { legs: [...used], odds: c }
    if (cutLegs[100]) break
  }
  return cutLegs
}

function toLegs(arr) {
  return arr.map(l => ({ fid: l.fid, fixtureId: l.fid, game: l.game, league: l.league, kickoff: new Date(l.kickoff).toISOString(), outcome: l.label, odds: l.odds, prob: l.prob, rawMarketId: l.marketId, rawSpecifier: l.specifier || '', rawOutcomeId: l.outcomeId }))
}

for (let round = 1; round <= 10; round++) {
  const avail = pool.filter(p => !excluded.has(p.fid))
  const cuts = buildSlices(avail)
  if (!cuts[100]) { console.log('CANNOT REACH 100x — pool exhausted, max legs:', avail.length); break }
  const legsTop = toLegs(cuts[100].legs)
  writeFileSync('slip-fbou15-100x.json', JSON.stringify({ legs: legsTop }, null, 2))
  console.log(`\nROUND ${round}: 100x slip = ${legsTop.length} legs, odds ${cuts[100].odds.toFixed(2)}`)

  const sels = legsTop.map(l => ({ eventId: 'sr:match:' + l.fixtureId, marketId: l.rawMarketId, specifier: l.rawSpecifier, outcomeId: l.rawOutcomeId }))
  const r = await fetch('https://www.sportybet.com/api/ng/orders/share', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ selections: sels, shareType: 1 }) })
  const j = await r.json()
  console.log('bizCode', j.bizCode, 'code', j.data?.shareCode)
  let newBad = 0
  for (const o of j.data?.outcomes || []) {
    if (o.bookingStatus !== 'Booked') {
      const leg = legsTop.find(l => l.game === (o.homeTeamName + ' vs ' + o.awayTeamName))
      if (leg && !excluded.has(leg.fid)) { excluded.add(leg.fid); newBad++ }
    }
  }
  console.log('newly excluded:', newBad, '(total excluded:', excluded.size, ')')
  if (newBad === 0) {
    writeFileSync('slip-fbou15-10x.json', JSON.stringify({ legs: toLegs(cuts[10].legs) }, null, 2))
    writeFileSync('slip-fbou15-20x.json', JSON.stringify({ legs: toLegs(cuts[20].legs) }, null, 2))
    console.log('CLEAN at 100x — wrote 10x (', cuts[10].legs.length, 'legs,', cuts[10].odds.toFixed(2), ') and 20x (', cuts[20].legs.length, 'legs,', cuts[20].odds.toFixed(2), ')')
    break
  }
}

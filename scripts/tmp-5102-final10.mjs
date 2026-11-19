import { readFileSync, writeFileSync } from 'node:fs'

const RISKY_LEAGUE_RE = /^J2 League$|^J3 League$|Serie C|Eerste Divisie|Liga de Expansion|^Ettan$|A-League, Women|Eredivisie, Women|Super League( 2)?, Women|Tercera Federacion|Promotion d.Honneur|^2\. Liga$|Primera Division, Women|Premier League, Women|U20|U19/
const BAD_NAME_RE = /Municipal Limeno|CD Fuerte San Francisco|Albacete Balompie|Aragua FC|CD Moquegua|UTC de Cajamarca|AS Bakaridjan|Irapuato|Pitbulls Santa Barbara|New Mexico United/

const minK = Date.now() + 60 * 60 * 1000
const maxK = Date.UTC(2026, 10, 17, 6, 0, 0) // 08:00 CAT tomorrow
console.log('fb window', new Date(minK).toISOString(), '->', new Date(maxK).toISOString())
let games = []
for (let pg = 1; pg <= 100; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=18&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  let any = false
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    any = true
    if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
    if (/SRL|Esoccer|Simulated|Virtual|eFootball/i.test(t.name)) continue
    games.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime, markets: ev.markets || [] })
  }
  if (!any) break
}
console.log('total fb games', games.length)

const picks = []
for (const g of games) {
  if (BAD_NAME_RE.test(g.game)) continue
  if (RISKY_LEAGUE_RE.test(g.league)) continue
  const m = g.markets.find(x => x.id === '18' && x.specifier === 'total=1.5' && x.status === 0)
  if (!m) continue
  for (const o of m.outcomes || []) {
    if (!o.isActive || o.desc !== 'Over 1.5') continue
    const odds = parseFloat(o.odds), prob = parseFloat(o.probability)
    if (odds < 1.05) continue
    picks.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, marketId: '18', specifier: 'total=1.5', outcomeId: o.id, label: o.desc, odds, prob })
  }
}
picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.5102-final10-picks.json', JSON.stringify(picks, null, 2))
console.log('total picks:', picks.length)
let c = 1
for (const p of picks) c *= p.odds
console.log('max achievable odds if ALL used:', c.toFixed(2))

function buildSlice(avail, target) {
  let cc = 1, used = []
  for (const p of avail) {
    used.push(p); cc *= p.odds
    if (cc >= target) return { legs: used, odds: cc }
  }
  return null
}
function toLegs(arr) {
  return arr.map(l => ({ fid: l.fid, fixtureId: l.fid, game: l.game, league: l.league, kickoff: new Date(l.kickoff).toISOString(), outcome: l.label, odds: l.odds, prob: l.prob, rawMarketId: l.marketId, rawSpecifier: l.specifier || '', rawOutcomeId: l.outcomeId }))
}

const excluded = new Set()
for (let round = 1; round <= 10; round++) {
  const avail = picks.filter(p => !excluded.has(p.fid))
  const cut = buildSlice(avail, 10)
  if (!cut) { console.log('CANNOT REACH 10x — pool exhausted'); break }
  const legs = toLegs(cut.legs)
  writeFileSync('slip-5102-10x.json', JSON.stringify({ legs }, null, 2))
  console.log(`\nROUND ${round}: slip = ${legs.length} legs, odds ${cut.odds.toFixed(2)}`)
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
  if (newBad === 0) { console.log('CLEAN — slip-5102-10x.json ready'); break }
}

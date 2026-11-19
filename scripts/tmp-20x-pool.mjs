import { writeFileSync } from 'node:fs'
const minK = Date.now() + 15 * 60 * 1000
const maxK = Date.now() + 24 * 3600 * 1000
const sports = [
  { id: 1, name: 'Football', marketId: 18 },
  { id: 2, name: 'Basketball', marketId: 18 },
  { id: 4, name: 'Ice Hockey', marketId: 18 },
  { id: 5, name: 'Tennis', marketId: 186 },
]
let fixtures = []
for (const sp of sports) {
  for (let pg = 1; pg <= 25; pg++) {
    const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A${sp.id}&marketId=${sp.marketId}&pageSize=100&pageNum=${pg}`)
    const j = await r.json()
    if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
    for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
      if (ev.estimateStartTime >= minK && ev.estimateStartTime <= maxK) {
        fixtures.push({ sport: sp.name, fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime, markets: ev.markets })
      }
    }
  }
}
console.log('fixtures found', fixtures.length)
writeFileSync('.20x-raw.json', JSON.stringify(fixtures))

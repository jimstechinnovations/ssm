import { writeFileSync } from 'node:fs'
const minK = new Date('2026-11-11T01:30:00Z').getTime()
const maxK = new Date('2026-11-11T03:00:00Z').getTime()
let all = []
for (let pg = 1; pg <= 25; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=18&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) { console.log('stopped at page', pg); break }
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    if (ev.estimateStartTime >= minK && ev.estimateStartTime <= maxK) {
      all.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: new Date(ev.estimateStartTime).toISOString(), markets: ev.markets })
    }
  }
}
console.log('total found', all.length)
writeFileSync('.230-400-raw.json', JSON.stringify(all))

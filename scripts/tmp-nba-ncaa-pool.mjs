import { writeFileSync } from 'node:fs'
const minK = Date.now() + 10 * 60 * 1000
const maxK = Date.now() + 20 * 3600 * 1000
let all = []
for (let pg = 1; pg <= 15; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A2&marketId=18&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  for (const t of j.data.tournaments) {
    if (!/NBA|NCAA/i.test(t.name)) continue
    for (const ev of (t.events || [])) {
      if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
      all.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime })
    }
  }
}
console.log('total', all.length)
const nba = all.filter(a => /NBA/i.test(a.league))
const ncaa = all.filter(a => /NCAA/i.test(a.league))
console.log('NBA', nba.length, 'NCAA', ncaa.length)
writeFileSync('.nba-ncaa-raw.json', JSON.stringify(all))
for (const a of all) console.log(a.league, a.game, new Date(a.kickoff).toISOString())

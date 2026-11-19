import { writeFileSync } from 'node:fs'
const minK = Date.now() + 10 * 60 * 1000
const maxK = Date.now() + 36 * 60 * 60 * 1000

async function fetchSport(sportId, marketId) {
  let games = []
  for (let pg = 1; pg <= 150; pg++) {
    const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A${sportId}&marketId=${marketId}&pageSize=100&pageNum=${pg}`)
    const j = await r.json()
    if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
    let any = false
    for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
      any = true
      if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
      if (/SRL/i.test(t.name)) continue
      games.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime, markets: ev.markets || [] })
    }
    if (!any) break
  }
  return games
}

const football = await fetchSport(1, 18)
const basketball = await fetchSport(2, 1)
writeFileSync('.long3000-football-raw.json', JSON.stringify(football))
writeFileSync('.long3000-basketball-raw.json', JSON.stringify(basketball))
console.log('football:', football.length, 'basketball:', basketball.length)

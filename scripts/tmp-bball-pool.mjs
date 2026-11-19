import { writeFileSync } from 'node:fs'
const minK = Date.now() + 10 * 60 * 1000
const maxK = Date.now() + 14 * 60 * 60 * 1000
let games = []
for (let pg = 1; pg <= 50; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A2&marketId=1&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  let any = false
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    any = true
    if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
    games.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime })
  }
  if (!any) break
}
console.log('total', games.length)
writeFileSync('.bball-pool.json', JSON.stringify(games))
games.sort((a,b)=>a.kickoff-b.kickoff)
for (const g of games) console.log(g.fid, g.game, '|', g.league, '|', new Date(g.kickoff).toISOString())

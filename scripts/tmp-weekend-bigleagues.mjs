import { writeFileSync } from 'node:fs'
const minK = new Date('2026-11-13T22:00:00Z').getTime()
const maxK = new Date('2026-11-15T22:00:00Z').getTime()
const bigLeagues = /Premier League, England|Premier League,England|LaLiga,|^LaLiga$|Serie A,|Serie A$|Bundesliga,|^Bundesliga$|Ligue 1,|^Ligue 1$|Eredivisie|Primeira Liga|English Premier League/i
let games = []
for (let pg = 1; pg <= 80; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=1&pageSize=100&pageNum=' + pg)
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
writeFileSync('.weekend-all.json', JSON.stringify(games))
console.log('total in window', games.length)
const leagues = new Set(games.map(g=>g.league))
console.log('distinct leagues:', [...leagues].sort().join(' | '))

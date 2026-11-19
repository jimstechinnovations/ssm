import { writeFileSync } from 'node:fs'
const minK = Date.now()
const maxK = Date.now() + 5 * 24 * 60 * 60 * 1000
let games = []
for (let pg = 1; pg <= 150; pg++) {
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
writeFileSync('.nl-afcon-all.json', JSON.stringify(games))
console.log('total pool', games.length)
const leagues = new Set(games.map(g=>g.league))
const matches = [...leagues].filter(l => /nations league|afcon|africa cup of nations|cosafa/i.test(l))
console.log('matching league names:', matches.join(' | '))

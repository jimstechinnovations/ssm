import { writeFileSync } from 'node:fs'
const minK = Date.UTC(2026, 10, 20, 22, 0, 0)
const maxK = Date.UTC(2026, 10, 21, 21, 59, 59)
console.log('Saturday CAT window', new Date(minK).toISOString(), '->', new Date(maxK).toISOString())
let games = []
for (let pg = 1; pg <= 150; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=18,1,19,20&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  let any = false
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    any = true
    if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
    if (/SRL|Esoccer|Simulated|Virtual|eFootball/i.test(t.name)) continue
    games.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, home: ev.homeTeamName, away: ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime, markets: ev.markets || [] })
  }
  if (!any) break
}
console.log('total Saturday fb games listed so far:', games.length)
writeFileSync('.sat1121-pool.json', JSON.stringify(games))

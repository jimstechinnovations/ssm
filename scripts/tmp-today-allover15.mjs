import { writeFileSync } from 'node:fs'
const minK = Date.now()
const maxK = new Date('2026-11-13T22:00:00Z').getTime() // ~midnight CAT
let games = []
for (let pg = 1; pg <= 150; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=18&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  let any = false
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    any = true
    if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
    if (/^UEFA Nations League$|^UEFA Nations League SRL$|^Africa Cup of Nations Qualification$/.test(t.name)) continue
    if (/SRL/i.test(t.name)) continue
    games.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime, markets: ev.markets || [] })
  }
  if (!any) break
}
writeFileSync('.today-nonleague-raw.json', JSON.stringify(games))
console.log('total pool (excl NL/AFCON/SRL):', games.length)

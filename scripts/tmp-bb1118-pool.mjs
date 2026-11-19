import { writeFileSync } from 'node:fs'
const minK = Date.now() + 60 * 60 * 1000
const maxK = Date.now() + 20 * 60 * 60 * 1000
console.log('bb window', new Date(minK).toISOString(), '->', new Date(maxK).toISOString())
const SAFE_LEAGUE_RE = /^NBA$|^Euroleague$|^NCAA, Regular Season$|^NCAA Women, Regular Season$/
let games = []
for (let pg = 1; pg <= 50; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A2&marketId=225&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  let any = false
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    any = true
    if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
    if (/Simulat|Virtual|SRL/i.test(t.name)) continue
    if (!SAFE_LEAGUE_RE.test(t.name)) continue
    games.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, home: ev.homeTeamName, away: ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime, markets: ev.markets || [] })
  }
  if (!any) break
}
console.log('well-covered-league bb games:', games.length)
writeFileSync('.bb1118-pool.json', JSON.stringify(games))

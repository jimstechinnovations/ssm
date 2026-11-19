import { writeFileSync } from 'node:fs'
const minK = Date.now() + 15 * 60 * 1000
const maxK = Date.now() + 20 * 60 * 60 * 1000
let games = []
for (let pg = 1; pg <= 50; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A2&marketId=1&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  let any = false
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    any = true
    if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
    if (/SRL/i.test(t.name)) continue
    games.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime })
  }
  if (!any) break
}
console.log('total', games.length)
writeFileSync('.bball-today2-pool.json', JSON.stringify(games))
const byLeague = {}
for (const g of games) (byLeague[g.league]=byLeague[g.league]||[]).push(g)
for (const [lg, arr] of Object.entries(byLeague).sort((a,b)=>b[1].length-a[1].length).slice(0,15)) console.log(lg, arr.length)

import { writeFileSync } from 'node:fs'
const minK = Date.now() + 5 * 60 * 1000
const maxK = Date.now() + 6 * 60 * 60 * 1000
console.log('window', new Date(minK).toISOString(), '->', new Date(maxK).toISOString())
let games = []
for (let pg = 1; pg <= 100; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=1&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  let any = false
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    any = true
    if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
    if (/SRL|Esoccer|Simulated|Virtual|eFootball/i.test(t.name)) continue
    games.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime })
  }
  if (!any) break
}
console.log('total games', games.length)
games.sort((a,b)=>a.kickoff-b.kickoff)
writeFileSync('.fbtonight-pool.json', JSON.stringify(games))
const byLeague = {}
for (const g of games) (byLeague[g.league]=byLeague[g.league]||[]).push(g)
console.log('leagues:', Object.keys(byLeague).length)
for (const [lg, arr] of Object.entries(byLeague).sort((a,b)=>b[1].length-a[1].length)) console.log(lg, '(' + arr.length + ')');

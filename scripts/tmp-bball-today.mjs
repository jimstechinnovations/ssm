const minK = Date.now()
const maxK = new Date(new Date().toISOString().slice(0,10) + 'T23:59:59Z').getTime() + 2*60*60*1000 // through midnight CAT
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
console.log('total basketball games left today (through midnight CAT):', games.length)
games.sort((a,b)=>a.kickoff-b.kickoff)
const byLeague = {}
for (const g of games) (byLeague[g.league]=byLeague[g.league]||[]).push(g)
for (const [lg, arr] of Object.entries(byLeague).sort((a,b)=>b[1].length-a[1].length)) {
  console.log(lg, arr.length)
}

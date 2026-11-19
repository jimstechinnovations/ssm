import { writeFileSync } from 'node:fs'
const minK = Date.now()
const maxK = new Date('2026-11-30T23:59:59Z').getTime()
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
writeFileSync('.month-all.json', JSON.stringify(games))
console.log('total through Nov 30:', games.length)
const bigNames = /^LaLiga$|^Serie A$|^Bundesliga$|^Ligue 1$|Premier League/
const matches = games.filter(g=>bigNames.test(g.league));
const byLeague = {};
for (const g of matches) (byLeague[g.league]=byLeague[g.league]||[]).push(g);
for (const [lg, arr] of Object.entries(byLeague)) {
  console.log('===', lg, arr.length);
  for (const g of arr.slice(0,3)) console.log('  ', g.game, new Date(g.kickoff).toISOString());
}

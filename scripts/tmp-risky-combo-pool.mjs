import { writeFileSync } from 'node:fs'
const minK = Date.now() + 60 * 60 * 1000
const maxK = Date.now() + 18 * 60 * 60 * 1000
console.log('window', new Date(minK).toISOString(), '->', new Date(maxK).toISOString())

let fbGames = []
for (let pg = 1; pg <= 100; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=18&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  let any = false
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    any = true
    if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
    if (/SRL|Esoccer|Simulated|Virtual|eFootball/i.test(t.name)) continue
    fbGames.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime, markets: ev.markets || [] })
  }
  if (!any) break
}
console.log('fb games:', fbGames.length)
writeFileSync('.riskycombo-fbpool.json', JSON.stringify(fbGames))

let bbGames = []
for (let pg = 1; pg <= 100; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A2&marketId=225&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  let any = false
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    any = true
    if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
    if (/SRL|Esoccer|Simulated|Virtual/i.test(t.name)) continue
    bbGames.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime, markets: ev.markets || [] })
  }
  if (!any) break
}
console.log('bb games:', bbGames.length)
writeFileSync('.riskycombo-bbpool.json', JSON.stringify(bbGames))

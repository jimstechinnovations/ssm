import { writeFileSync } from 'node:fs'
const minK = Date.now() + 60 * 60 * 1000
const endOfDayCAT = (() => {
  const now = new Date()
  const catNow = new Date(now.getTime() + 2 * 3600 * 1000)
  const eod = new Date(Date.UTC(catNow.getUTCFullYear(), catNow.getUTCMonth(), catNow.getUTCDate(), 23, 59, 59))
  return eod.getTime() - 2 * 3600 * 1000
})()
const maxK = endOfDayCAT
console.log('window', new Date(minK).toISOString(), '->', new Date(maxK).toISOString())
let games = []
for (let pg = 1; pg <= 100; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=18&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  let any = false
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    any = true
    if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
    if (/SRL|Esoccer|Simulated|Virtual|eFootball/i.test(t.name)) continue
    games.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime, markets: ev.markets || [] })
  }
  if (!any) break
}
console.log('total games', games.length)
writeFileSync('.fbtoday-pool.json', JSON.stringify(games))

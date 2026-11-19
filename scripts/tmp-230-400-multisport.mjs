import { writeFileSync } from 'node:fs'
const minK = new Date('2026-11-11T01:30:00Z').getTime()
const maxK = new Date('2026-11-11T03:00:00Z').getTime()
const sports = [
  { id: 1, name: 'Football', marketId: 18 },
  { id: 2, name: 'Basketball', marketId: 18 },
  { id: 5, name: 'Tennis', marketId: 186 },
  { id: 4, name: 'Ice Hockey', marketId: 18 },
]
let all = []
for (const sp of sports) {
  for (let pg = 1; pg <= 15; pg++) {
    const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A${sp.id}&marketId=${sp.marketId}&pageSize=100&pageNum=${pg}`)
    const j = await r.json()
    if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
    for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
      if (ev.estimateStartTime >= minK && ev.estimateStartTime <= maxK) {
        all.push({ sport: sp.name, fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: new Date(ev.estimateStartTime).toISOString(), markets: ev.markets.map(m => ({ id: m.id, specifier: m.specifier, outcomes: m.outcomes.map(o => ({ id: o.id, odds: o.odds, prob: o.probability, desc: o.desc, isActive: o.isActive })) })) })
      }
    }
  }
}
console.log('total found', all.length)
for (const a of all) console.log(a.sport, a.league, a.game, a.kickoff)
writeFileSync('.230-400-multi-raw.json', JSON.stringify(all))

import { writeFileSync } from 'node:fs'
const minK = Date.now() + 20 * 60 * 1000
const maxK = Date.now() + 48 * 3600 * 1000
let cands = []
for (let pg = 1; pg <= 40 && cands.length < 200; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=18&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
    let pick = null
    for (const line of [4.5, 5.5, 3.5]) {
      const m = (ev.markets || []).find(x => x.specifier === 'total=' + line)
      if (!m) continue
      const u = m.outcomes.find(o => /under/i.test(o.desc)), o = m.outcomes.find(x => /over/i.test(x.desc))
      if (!u || !o) continue
      const uo = +u.odds
      if (uo >= 1.20) { pick = { fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime, line, odds: uo, prob: +u.probability, outcomeId: u.id }; break }
    }
    if (pick) cands.push(pick)
  }
}
console.log('candidates', cands.length)
cands.sort((a, b) => b.prob - a.prob) // safest first
writeFileSync('.long-under-cands.json', JSON.stringify(cands))

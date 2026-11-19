import { writeFileSync } from 'node:fs'
const minK = Date.now() + 10 * 60 * 1000
const maxK = new Date('2026-11-12T04:00:00Z').getTime()
let cands = []
for (let pg = 1; pg <= 40 && cands.length < 400; pg++) {
  const r = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=10&pageSize=100&pageNum=' + pg)
  const j = await r.json()
  if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
  let any = false
  for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
    any = true
    if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
    const m = (ev.markets || []).find(x => x.id === '10')
    if (!m) continue
    let best = null
    for (const o of m.outcomes) { if (!best || +o.probability > +best.probability) best = o }
    if (!best) continue
    cands.push({ fid: ev.eventId.split(':').pop(), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime, outcome: best.desc, odds: +best.odds, prob: +best.probability, outcomeId: best.id })
  }
  if (!any) break
}
cands.sort((a,b) => b.prob - a.prob)
writeFileSync('.tonight-sure-cands.json', JSON.stringify(cands))
console.log('total', cands.length)
for (const c of cands.slice(0, 30)) console.log(c.game, '|', c.league, '|', new Date(c.kickoff).toISOString(), '|', c.outcome, c.odds, (c.prob*100).toFixed(1)+'%')

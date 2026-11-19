import { writeFileSync } from 'node:fs'
const minK = Date.now() + 10 * 60 * 1000
const maxK = Date.now() + 36 * 60 * 60 * 1000

async function fetchAll(marketId) {
  const map = new Map()
  for (let pg = 1; pg <= 60; pg++) {
    const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=${marketId}&pageSize=100&pageNum=${pg}`)
    const j = await r.json()
    if (!j.data || !j.data.tournaments || !j.data.tournaments.length) break
    let any = false
    for (const t of j.data.tournaments) for (const ev of (t.events || [])) {
      any = true
      if (ev.estimateStartTime < minK || ev.estimateStartTime > maxK) continue
      if (/SRL/i.test(t.name) || /SRL/.test(ev.homeTeamName + ev.awayTeamName)) continue
      const fid = ev.eventId.split(':').pop()
      map.set(fid, { fid, game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, kickoff: ev.estimateStartTime, markets: ev.markets || [] })
    }
    if (!any) break
  }
  return map
}

const over05Map = await fetchAll(18)
const dcMap = await fetchAll(10)
console.log('over05 pool', over05Map.size, 'dc pool', dcMap.size)

const picks = []
const allFids = new Set([...over05Map.keys(), ...dcMap.keys()])
for (const fid of allFids) {
  const g = over05Map.get(fid) || dcMap.get(fid)
  let best = null
  const o5g = over05Map.get(fid)
  if (o5g) {
    const m = (o5g.markets || []).find(x => x.id === '18' && x.specifier === 'total=0.5')
    const o = m && m.outcomes.find(oo => /over/i.test(oo.desc))
    if (o) best = { marketId: '18', specifier: 'total=0.5', outcome: 'Over 0.5', odds: +o.odds, prob: +o.probability, outcomeId: o.id }
  }
  const dcg = dcMap.get(fid)
  if (dcg) {
    const m = (dcg.markets || []).find(x => x.id === '10')
    const o = m && m.outcomes.find(oo => oo.desc === 'Home or Away')
    if (o && (!best || +o.probability > best.prob)) best = { marketId: '10', specifier: '', outcome: 'Home or Away', odds: +o.odds, prob: +o.probability, outcomeId: o.id }
  }
  if (best) picks.push({ fid, game: g.game, league: g.league, kickoff: g.kickoff, ...best })
}
picks.sort((a, b) => b.prob - a.prob)
writeFileSync('.over05dc-pool.json', JSON.stringify(picks))
console.log('total picks', picks.length)
for (const p of picks.slice(0, 60)) console.log(p.game, '|', p.league, '|', new Date(p.kickoff).toISOString(), '|', p.outcome, '@'+p.odds, (p.prob*100).toFixed(1)+'%')

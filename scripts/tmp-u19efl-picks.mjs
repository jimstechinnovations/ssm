import { readFileSync, writeFileSync } from 'node:fs'
const games = JSON.parse(readFileSync('.today-u19-efl.json', 'utf8'))
let out = []
for (const g of games) {
  let j = await (await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${g.fid}&productId=3`)).json()
  let markets = (j.data && j.data.markets) || []
  let usedP1 = false
  if (!markets.length) {
    j = await (await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${g.fid}&productId=1`)).json()
    markets = (j.data && j.data.markets) || []
    usedP1 = true
  }
  const cands = []
  for (const m of markets) {
    const id = String(m.id)
    if (!['1','10','18','29'].includes(id)) continue
    for (const o of m.outcomes) {
      const odds = +o.odds
      if (odds < 1.25 || odds > 2.3) continue
      cands.push({ marketId: id, marketName: m.name, specifier: m.specifier, outcome: o.desc, odds, prob: +o.probability, outcomeId: o.id })
    }
  }
  cands.sort((a,b) => b.prob - a.prob)
  out.push({ ...g, usedP1, top: cands.slice(0,3) })
}
writeFileSync('.u19efl-picks.json', JSON.stringify(out))
for (const g of out) {
  console.log('---', g.game, g.league, new Date(g.kickoff).toISOString(), g.usedP1?'(p1)':'(p3)')
  for (const c of g.top) console.log('  ', c.marketName, c.specifier||'', c.outcome, '@'+c.odds, (c.prob*100).toFixed(1)+'%')
}

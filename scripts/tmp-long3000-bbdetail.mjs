import { readFileSync, writeFileSync } from 'node:fs'
const games = JSON.parse(readFileSync('.long3000-bb-filtered.json', 'utf8'))
const out = []
let i = 0
for (const g of games) {
  let ev = null
  for (const pid of [3, 1]) {
    try {
      const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${g.fid}&productId=${pid}`, { headers: { Accept: 'application/json' } })
      const j = await r.json()
      if (j.data && j.data.markets && j.data.markets.length) { ev = j.data; break }
    } catch {}
  }
  out.push({ fid: g.fid, game: g.game, league: g.league, kickoff: g.kickoff, markets: ev ? ev.markets : [] })
  i++
  if (i % 40 === 0) console.log('progress', i, '/', games.length)
  await new Promise(r => setTimeout(r, 60))
}
writeFileSync('.long3000-bb-detail.json', JSON.stringify(out))
console.log('done', out.length, 'with markets:', out.filter(x => x.markets.length).length)

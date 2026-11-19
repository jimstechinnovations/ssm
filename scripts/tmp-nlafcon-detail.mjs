import { readFileSync, writeFileSync } from 'node:fs'
const games = JSON.parse(readFileSync('.today-nl-afcon.json', 'utf8'))
const out = []
for (const g of games) {
  let ev = null
  for (const pid of [3, 1]) {
    try {
      const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${g.fid}&productId=${pid}`, { headers: { Accept: 'application/json' } })
      const j = await r.json()
      if (j.data && j.data.markets && j.data.markets.length) { ev = j.data; break }
    } catch {}
  }
  out.push({ ...g, markets: ev ? ev.markets : [] })
  await new Promise(r => setTimeout(r, 90))
}
writeFileSync('.nlafcon-detail.json', JSON.stringify(out))
console.log('done', out.length, 'with markets:', out.filter(x=>x.markets.length).length)

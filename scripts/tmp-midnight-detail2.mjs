import { readFileSync, writeFileSync } from 'node:fs'

async function detail(games) {
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
    await new Promise(r => setTimeout(r, 80))
  }
  return out
}

const fb = JSON.parse(readFileSync('.midnight-football.json', 'utf8'))
const bb = JSON.parse(readFileSync('.midnight-bball-pool.json', 'utf8'))
const fbDetail = await detail(fb)
const bbDetail = await detail(bb)
writeFileSync('.midnight-football-detail.json', JSON.stringify(fbDetail))
writeFileSync('.midnight-bball-detail.json', JSON.stringify(bbDetail))
console.log('fb with markets:', fbDetail.filter(x=>x.markets.length).length, '/', fbDetail.length)
console.log('bb with markets:', bbDetail.filter(x=>x.markets.length).length, '/', bbDetail.length)

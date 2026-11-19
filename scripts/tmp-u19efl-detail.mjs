import { readFileSync, writeFileSync } from 'node:fs'
const games = JSON.parse(readFileSync('.today-u19-efl.json', 'utf8'))
let out = []
for (const g of games) {
  const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${g.fid}&productId=3`)
  const j = await r.json()
  const ev = j.data
  if (!ev) { console.log('NO DATA', g.fid, g.game); continue }
  out.push({ ...g, markets: ev.markets })
}
writeFileSync('.u19efl-detail.json', JSON.stringify(out))
console.log('fetched', out.length)

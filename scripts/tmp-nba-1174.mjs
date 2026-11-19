import { writeFileSync } from 'node:fs'
const fs = await import('node:fs/promises')
const all = JSON.parse(await fs.readFile('.nba-ncaa-raw.json', 'utf8'))
const nba = all.filter(a => /NBA/i.test(a.league))
const out = []
for (const g of nba) {
  const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${g.fid}&productId=3`)
  const j = await r.json()
  out.push({ ...g, markets: j.data?.markets })
}
writeFileSync('.nba-1174-detail.json', JSON.stringify(out))
for (const o of out) {
  console.log('===', o.game, new Date(o.kickoff).toISOString())
  const m1174 = (o.markets || []).find(m => m.id === '1174')
  if (m1174) console.log('  1174', m1174.specifier, m1174.outcomes.map(x => x.id + ':' + x.desc + '@' + x.odds + '(' + (+x.probability * 100).toFixed(1) + '%)'))
  else console.log('  1174 NOT AVAILABLE')
  const m223 = (o.markets || []).filter(m => m.id === '223')
  for (const m of m223.slice(0, 2)) console.log('  223(Hcp incl OT)', m.specifier, m.outcomes.map(x => x.id + ':' + x.desc + '@' + x.odds + '(' + (+x.probability * 100).toFixed(1) + '%)'))
}

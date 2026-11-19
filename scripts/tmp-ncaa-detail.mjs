import { writeFileSync } from 'node:fs'
const targets = [
  { game: 'Kentucky Wildcats vs Kansas Jayhawks', fid: '73867952' },
  { game: 'Michigan State Spartans vs Duke Blue Devils', fid: '73529000' },
  { game: 'Villanova Wildcats vs La Salle Explorers', fid: '74101526' },
  { game: 'Baylor Bears vs Yale Bulldogs', fid: '73303298' },
  { game: 'Xavier Musketeers vs Detroit Mercy Titans', fid: '73079584' },
]
const out = []
for (const t of targets) {
  const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${t.fid}&productId=3`)
  const j = await r.json()
  out.push({ ...t, markets: j.data?.markets })
}
writeFileSync('.ncaa-detail.json', JSON.stringify(out))
for (const o of out) {
  console.log('===', o.game)
  const m1174 = (o.markets || []).find(m => m.id === '1174')
  if (m1174) console.log('  1174', m1174.specifier, m1174.outcomes.map(x => x.id + ':' + x.desc + '@' + x.odds + '(' + (+x.probability * 100).toFixed(1) + '%)'))
  const m223 = (o.markets || []).sort((a,b)=>+a.specifier?.replace('hcp=','')-+b.specifier?.replace('hcp=','')).filter(m => m.id === '223')
  for (const m of m223.slice(0, 2)) console.log('  223', m.specifier, m.outcomes.map(x => x.id + ':' + x.desc + '@' + x.odds + '(' + (+x.probability * 100).toFixed(1) + '%)'))
}

import { writeFileSync } from 'node:fs'
const targets = [
  { game: 'Musetti vs Samuel', fid: '76430182', sport: 'Tennis' },
  { game: 'St Louis Blues vs Detroit Red Wings', fid: '72909422', sport: 'Ice Hockey' },
  { game: 'PSG W vs Bayern Munich W', fid: '74371840', sport: 'Football' },
  { game: 'Utah Jazz vs Miami Heat', fid: '73719600', sport: 'Basketball' },
  { game: 'Phoenix Suns vs LA Clippers', fid: '73719598', sport: 'Basketball' },
  { game: 'Sacramento Kings vs Orlando Magic', fid: '73719602', sport: 'Basketball' },
  { game: 'Czechia vs Germany', fid: '72071290', sport: 'Ice Hockey' },
  { game: 'Rinderknech vs Kecmanovic', fid: '76541910', sport: 'Tennis' },
  { game: 'Al Mokawloon Al Arab vs We SC', fid: '76079156', sport: 'Football' },
]
const out = []
for (const t of targets) {
  const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${t.fid}&productId=3`)
  const j = await r.json()
  out.push({ ...t, data: j.data })
}
writeFileSync('.20x-final-detail.json', JSON.stringify(out))
for (const o of out) {
  console.log('===', o.sport, o.game, o.data?.estimateStartTime ? new Date(o.data.estimateStartTime).toISOString() : '')
  const m1 = (o.data?.markets || []).find(m => m.id === '1')
  if (m1) console.log('  ML', m1.outcomes.map(x => x.id + ':' + x.desc + '@' + x.odds + '(' + (+x.probability * 100).toFixed(1) + '%)'))
  const m186 = (o.data?.markets || []).find(m => m.id === '186')
  if (m186) console.log('  Winner', m186.outcomes.map(x => x.id + ':' + x.desc + '@' + x.odds + '(' + (+x.probability * 100).toFixed(1) + '%)'))
  const m18 = (o.data?.markets || []).filter(m => m.id === '18' && (m.specifier === 'total=7.5' || m.specifier === 'total=4.5'))
  for (const mm of m18) console.log('  O/U', mm.specifier, mm.outcomes.map(x => x.id + ':' + x.desc + '@' + x.odds + '(' + (+x.probability * 100).toFixed(1) + '%)'))
}

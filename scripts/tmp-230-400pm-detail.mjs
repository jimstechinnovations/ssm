import { writeFileSync } from 'node:fs'
const targets = [
  { game: 'Finland vs Japan', fid: '72071312', sport: 'Ice Hockey' },
  { game: 'Czechia vs Germany', fid: '72071290', sport: 'Ice Hockey' },
  { game: 'Al Mokawloon Al Arab vs We SC', fid: '76079156', sport: 'Football' },
  { game: 'Rinderknech vs Kecmanovic', fid: '76541910', sport: 'Tennis' },
  { game: 'Traktor Chelyabinsk vs Shanghai Dragons', fid: '72166580', sport: 'Ice Hockey' },
  { game: 'JS Djidjel vs CR Beni Thour', fid: '75995512', sport: 'Football' },
  { game: 'MO Bejaia vs Nrb Nezla', fid: '75995518', sport: 'Football' },
  { game: 'Paradou AC vs JSM Skikda', fid: '75995522', sport: 'Football' },
  { game: 'WA Tlemcen vs RC Arbaa', fid: '75995514', sport: 'Football' },
]
const out = []
for (const t of targets) {
  const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${t.fid}&productId=3`)
  const j = await r.json()
  out.push({ ...t, markets: j.data?.markets })
}
writeFileSync('.230-400pm-detail.json', JSON.stringify(out))
for (const o of out) {
  console.log('===', o.sport, o.game)
  const m1 = (o.markets || []).find(m => m.id === '1')
  if (m1) console.log('  ML:', m1.outcomes.map(x => x.desc + ' @' + x.odds + ' (' + (+x.probability * 100).toFixed(1) + '%)').join(' | '))
  const m186 = (o.markets || []).find(m => m.id === '186')
  if (m186) console.log('  Winner:', m186.outcomes.map(x => x.desc + ' @' + x.odds + ' (' + (+x.probability * 100).toFixed(1) + '%)').join(' | '))
  const m29 = (o.markets || []).find(m => m.id === '29')
  if (m29) console.log('  BTTS:', m29.outcomes.map(x => x.desc + ' @' + x.odds + ' (' + (+x.probability * 100).toFixed(1) + '%)').join(' | '))
  const m18s = (o.markets || []).filter(m => m.id === '18')
  for (const mm of m18s.slice(0, 3)) console.log('  O/U', mm.specifier, mm.outcomes.map(x => x.desc + ' @' + x.odds + ' (' + (+x.probability * 100).toFixed(1) + '%)').join(' | '))
  const m10 = (o.markets || []).find(m => m.id === '10')
  if (m10) console.log('  DC:', m10.outcomes.map(x => x.desc + ' @' + x.odds + ' (' + (+x.probability * 100).toFixed(1) + '%)').join(' | '))
}

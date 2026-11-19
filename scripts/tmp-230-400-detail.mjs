import { writeFileSync } from 'node:fs'
const fids = {
  'Phoenix Suns vs LA Clippers': '76500001',
}
// fetch full market dump for key candidates by fid, from the multi-raw file
const all = JSON.parse(await (await import('node:fs/promises')).readFile('.230-400-multi-raw.json', 'utf8'))
const targets = all.filter(a => [
  'Phoenix Suns vs LA Clippers',
  'Utah Jazz vs Miami Heat',
  'Sacramento Kings vs Orlando Magic',
  'Los Angeles Kings vs Nashville Predators',
  'Kentucky Wildcats vs Kansas Jayhawks',
].includes(a.game))
const out = []
for (const t of targets) {
  const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${t.fid}&productId=3`)
  const j = await r.json()
  out.push({ game: t.game, sport: t.sport, fid: t.fid, kickoff: t.kickoff, markets: j.data?.markets })
}
writeFileSync('.230-400-detail.json', JSON.stringify(out))
for (const o of out) {
  console.log('===', o.game, o.kickoff)
  const m1 = (o.markets || []).find(m => m.id === '1')
  if (m1) console.log('  ML:', m1.outcomes.map(x => x.desc + ' @' + x.odds + ' (' + (+x.probability * 100).toFixed(1) + '%)').join(' | '))
  const m18 = (o.markets || []).find(m => m.id === '18' && m.specifier === 'total=228.5')
  const m18any = (o.markets || []).filter(m => m.id === '18')
  for (const mm of m18any.slice(0, 3)) console.log('  O/U', mm.specifier, mm.outcomes.map(x => x.desc + ' @' + x.odds + ' (' + (+x.probability * 100).toFixed(1) + '%)').join(' | '))
}

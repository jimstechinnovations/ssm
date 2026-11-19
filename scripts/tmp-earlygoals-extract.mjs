import { readFileSync, writeFileSync } from 'node:fs'
const games = JSON.parse(readFileSync('.nlafcon-detail.json', 'utf8'))
const cutoffUTC = new Date('2026-11-13T16:00:00Z').getTime()
const filtered = games.filter(g => g.kickoff >= cutoffUTC)

for (const g of filtered) {
  const egs = g.markets.filter(m => m.id === '60180')
  if (!egs.length) { console.log(g.game, '-- no early-goals market'); continue }
  console.log('===', g.game)
  for (const m of egs) {
    const over = m.outcomes.find(o => /Over/i.test(o.desc))
    const under = m.outcomes.find(o => /Under/i.test(o.desc))
    console.log(' ', m.specifier, over ? ('Over@'+over.odds+'('+(+over.probability*100).toFixed(0)+'%)') : '', under ? ('Under@'+under.odds+'('+(+under.probability*100).toFixed(0)+'%)') : '')
  }
}

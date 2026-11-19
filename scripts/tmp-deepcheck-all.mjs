import { readFileSync } from 'node:fs'
const files = process.argv.slice(2)
for (const file of files) {
  const s = JSON.parse(readFileSync(file, 'utf8'))
  const sels = s.legs.map(l => ({ eventId: 'sr:match:' + l.fixtureId, marketId: l.rawMarketId, specifier: l.rawSpecifier || '', outcomeId: l.rawOutcomeId }))
  const r = await fetch('https://www.sportybet.com/api/ng/orders/share', { method: 'POST', headers: {'Content-Type':'application/json','Accept':'application/json'}, body: JSON.stringify({ selections: sels, shareType: 1 }) })
  const j = await r.json()
  const bad = []
  for (const o of j.data?.outcomes || []) {
    const mk = o.markets && o.markets[0]; const oc = mk && mk.outcomes && mk.outcomes[0]
    if (mk?.status !== 0 || !oc?.isActive || o.bookingStatus !== 'Booked') bad.push(o.homeTeamName + ' vs ' + o.awayTeamName + ' (' + o.bookingStatus + ')')
  }
  console.log(file, '-> bizCode', j.bizCode, 'code', j.data?.shareCode, 'bad', bad.length, bad.join(' | '))
  await new Promise(r => setTimeout(r, 150))
}

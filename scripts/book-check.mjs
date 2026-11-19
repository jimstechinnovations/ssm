import { readFileSync } from 'node:fs'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const f = process.argv[2]
const s = JSON.parse(readFileSync(f, 'utf8'))
const now = Date.now()
const sels = s.legs.map(l => ({ eventId: 'sr:match:' + l.fixtureId, marketId: l.rawMarketId, specifier: l.rawSpecifier || '', outcomeId: l.rawOutcomeId }))
const r = await fetch('https://www.sportybet.com/api/ng/orders/share', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ selections: sels, shareType: 1 }) })
const j = await r.json()
console.log('bizCode', j.bizCode, 'code', j.data?.shareCode)
const bad = []
for (const o of j.data?.outcomes || []) { if (o.bookingStatus !== 'Booked') bad.push(o) }
console.log('total outcomes', (j.data?.outcomes || []).length, 'not booked', bad.length)
for (const b of bad) console.log(b.eventId, b.bookingStatus, b.homeTeamName, b.awayTeamName)
console.log('started already:', s.legs.filter(l => new Date(l.kickoff).getTime() < now).map(l => l.game).join(' | '))

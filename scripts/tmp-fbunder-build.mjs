import { readFileSync, writeFileSync } from 'node:fs'
const pool = JSON.parse(readFileSync('.fbunder-picks.json', 'utf8'))
const excluded = new Set(['75466980']) // placeholder, overwritten below
const EXCLUDE_GAMES = new Set(['Veertien Mie vs Iwate Grulla Morioka', 'FC Ska-Khabarovsk vs Leningradets'])
const chosen = pool.filter(p => !EXCLUDE_GAMES.has(p.game)).slice(0, 6)
const legs = chosen.map(l => ({ fid: l.fid, fixtureId: l.fid, game: l.game, league: l.league, kickoff: new Date(l.kickoff).toISOString(), outcome: l.label, odds: l.odds, prob: l.prob, rawMarketId: l.marketId, rawSpecifier: l.specifier || '', rawOutcomeId: l.outcomeId }))
writeFileSync('slip-fbunder-6.json', JSON.stringify({ legs }, null, 2))

const sels = legs.map(l => ({ eventId: 'sr:match:' + l.fixtureId, marketId: l.rawMarketId, specifier: l.rawSpecifier, outcomeId: l.rawOutcomeId }))
const r = await fetch('https://www.sportybet.com/api/ng/orders/share', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ selections: sels, shareType: 1 }) })
const j = await r.json()
console.log('bizCode', j.bizCode, 'code', j.data?.shareCode)
for (const o of j.data?.outcomes || []) console.log(o.homeTeamName, 'vs', o.awayTeamName, '->', o.bookingStatus)

let odds = 1, prob = 1
for (const l of legs) { odds *= l.odds; prob *= l.prob }
console.log('TOTAL ODDS', odds.toFixed(2), 'TRUE PROB', (prob*100).toFixed(2) + '%')

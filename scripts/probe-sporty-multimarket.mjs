/**
 * scripts/probe-sporty-multimarket.mjs — discover SportyBet's marketId/specifier/outcomeId scheme
 * for markets beyond Over/Under totals (id 18): 1X2, Double Chance, Draw No Bet, Asian Handicap.
 * Fetches the SAME public feed the live adapter (lib/books/sportybet.ts) uses, but WITHOUT the
 * marketId=18 filter, and dumps every market present on a handful of real upcoming fixtures.
 * Run: node scripts/probe-sporty-multimarket.mjs
 */
const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const marketId = process.argv[2] ?? '1,18,10,11,60,16'
const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=${encodeURIComponent(marketId)}&pageSize=5&pageNum=1`

const res = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' },
})
if (!res.ok) { console.error('HTTP', res.status); process.exit(1) }
const json = await res.json()
if (json.bizCode !== 10000) { console.error('bizCode', json.bizCode); process.exit(1) }

const tournaments = json.data?.tournaments ?? []
let shown = 0
for (const t of tournaments) {
  for (const ev of t.events ?? []) {
    if (shown >= 3) break
    console.log(`\n===== ${ev.homeTeamName} vs ${ev.awayTeamName} (${t.name}) — eventId ${ev.eventId} =====`)
    for (const m of ev.markets ?? []) {
      console.log(`  market id=${m.id} name=${m.name ?? m.desc ?? '?'} specifier=${m.specifier ?? ''} status=${m.status}`)
      for (const o of m.outcomes ?? []) {
        console.log(`      outcome id=${o.id} desc="${o.desc}" odds=${o.odds}`)
      }
    }
    shown++
  }
  if (shown >= 3) break
}
console.log(`\n(dumped ${shown} fixtures' full market lists)`)

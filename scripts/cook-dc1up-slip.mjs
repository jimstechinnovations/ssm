/**
 * scripts/cook-dc1up-slip.mjs — same safest-first cooker, restricted to Double Chance 1UP
 * (marketId 60110: pays out immediately if your side ever leads, regardless of final result).
 * "Home or Away" (12) isn't offered under 1UP since there's no single leading side for it —
 * only Home-or-Draw (9) and Draw-or-Away (11) are active. Picks whichever is safest per game.
 *
 * Usage:
 *   node scripts/cook-dc1up-slip.mjs --target=5 --toISO=2026-08-30T23:00:00Z --out=slip-dc1up.json
 */
import { writeFileSync } from 'node:fs'

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const MIN_ODDS = 1.20

const arg = (name, fallback = null) => {
  const found = process.argv.find(x => x.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const TARGET = Number(arg('target', '5'))
const OUT = arg('out', 'slip-dc1up.json')
const FROM = Date.now()
const TO = arg('toISO') ? new Date(arg('toISO')).getTime() : Date.now() + Number(arg('hours', '24')) * 3600 * 1000

const isSimulated = (t, ev) => /simulat/i.test(t.category?.name || '') || /\bsrl\b/i.test(ev.homeTeamName || '') || /\bsrl\b/i.test(ev.awayTeamName || '')
const OUTCOME_ID_TO_LABEL = { '9': 'Home or Draw (1UP)', '10': 'Home or Away (1UP)', '11': 'Draw or Away (1UP)' }

console.log(`Window: ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()}`)
console.log(`Market: Double Chance 1UP (early payout if your side ever leads)`)
console.log(`Target combined odds: ${TARGET}x`)

const all = []
for (let pg = 1; pg <= 20; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=60110&pageSize=100&pageNum=${pg}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) {
    for (const ev of t.events || []) {
      pageEvents++
      if (isSimulated(t, ev)) continue
      if (ev.estimateStartTime < FROM || ev.estimateStartTime > TO) continue
      const m = (ev.markets || []).find(x => x.id === '60110' && (x.status === undefined || x.status === 0))
      if (!m) continue
      const opts = (m.outcomes || []).filter(o => o.isActive === 1 && +o.odds > 1)
      if (!opts.length) continue
      const cheapest = [...opts].sort((a, b) => +a.odds - +b.odds)[0]
      if (+cheapest.odds < MIN_ODDS) continue
      all.push({
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        league: t.name,
        kickoff: new Date(ev.estimateStartTime).toISOString(),
        kickoffMs: ev.estimateStartTime,
        odds: +cheapest.odds,
        trueProb: +cheapest.probability,
        outcomeId: cheapest.id,
        outcomeLabel: OUTCOME_ID_TO_LABEL[cheapest.id] || cheapest.desc,
      })
    }
  }
  if (pageEvents === 0 && pg > 8) break
}
all.sort((a, b) => b.trueProb - a.trueProb)

const legs = []
let product = 1
for (const row of all) {
  if (product >= TARGET) break
  legs.push(row)
  product *= row.odds
}
legs.sort((a, b) => a.kickoffMs - b.kickoffMs)

console.log(`\nCooked DC 1UP slip — ${legs.length} legs, combined odds ${product.toFixed(2)}x`)
for (const l of legs) console.log(`[${l.league}] ${l.kickoff}  ${l.game} -> ${l.outcomeLabel} @ ${l.odds} (${(l.trueProb * 100).toFixed(1)}%)`)

const ticket = {
  generatedAt: new Date().toISOString(),
  window: { fromISO: new Date(FROM).toISOString(), toISO: new Date(TO).toISOString() },
  market: 'Double Chance 1UP (early payout)',
  target: TARGET,
  combinedOdds: product,
  note: 'Preview only. No stake entered and no bet placed.',
  legs: legs.map(l => ({ fixtureId: l.fixtureId, game: l.game, league: l.league, kickoff: l.kickoff, market: 'DC1UP', outcome: l.outcomeLabel, odds: l.odds, trueProb: l.trueProb, rawMarketId: '60110', rawSpecifier: '', rawOutcomeId: l.outcomeId })),
}
writeFileSync(OUT, JSON.stringify(ticket, null, 2))
console.log(`\nWrote ${OUT}`)

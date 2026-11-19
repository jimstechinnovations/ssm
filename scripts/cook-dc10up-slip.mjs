/**
 * scripts/cook-dc10up-slip.mjs — hah, name aside: this is the "10 Minutes - 1X2" market
 * (marketId 105, specifier from=1|to=10), restricted to the Draw outcome (id 2) — i.e. the
 * score is still level after the first 10 minutes. Naturally very safe (most matches are
 * still 0-0 that early), ranked by true probability, same safest-first cooker as the others.
 *
 * Usage:
 *   node scripts/cook-dc10up-slip.mjs --target=5 --fromISO=2026-08-30T23:00:00Z --toISO=2026-08-31T23:00:00Z --out=slip-10min-draw.json
 */
import { writeFileSync } from 'node:fs'

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const MIN_ODDS = 1.05

const arg = (name, fallback = null) => {
  const found = process.argv.find(x => x.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const TARGET = Number(arg('target', '5'))
const OUT = arg('out', 'slip-10min-draw.json')
const FROM = arg('fromISO') ? new Date(arg('fromISO')).getTime() : Date.now()
const TO = arg('toISO') ? new Date(arg('toISO')).getTime() : Date.now() + Number(arg('hours', '24')) * 3600 * 1000

const isSimulated = (t, ev) => /simulat/i.test(t.category?.name || '') || /\bsrl\b/i.test(ev.homeTeamName || '') || /\bsrl\b/i.test(ev.awayTeamName || '')

console.log(`Window: ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()}`)
console.log(`Market: 10 Minutes - 1X2, Draw only`)
console.log(`Target combined odds: ${TARGET}x`)

const all = []
for (let pg = 1; pg <= 20; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=105&pageSize=100&pageNum=${pg}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) {
    for (const ev of t.events || []) {
      pageEvents++
      if (isSimulated(t, ev)) continue
      if (ev.estimateStartTime < FROM || ev.estimateStartTime > TO) continue
      const m = (ev.markets || []).find(x => x.id === '105' && x.specifier === 'from=1|to=10' && (x.status === undefined || x.status === 0))
      if (!m) continue
      const draw = m.outcomes.find(o => /^draw/i.test(o.desc))
      if (!draw || draw.isActive !== 1 || +draw.odds < MIN_ODDS) continue
      all.push({
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        league: t.name,
        kickoff: new Date(ev.estimateStartTime).toISOString(),
        kickoffMs: ev.estimateStartTime,
        odds: +draw.odds,
        trueProb: +draw.probability,
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

console.log(`\nCooked 10-Min Draw slip — ${legs.length} legs, combined odds ${product.toFixed(2)}x`)
for (const l of legs) console.log(`[${l.league}] ${l.kickoff}  ${l.game} -> 10min Draw @ ${l.odds} (${(l.trueProb * 100).toFixed(1)}%)`)

const ticket = {
  generatedAt: new Date().toISOString(),
  window: { fromISO: new Date(FROM).toISOString(), toISO: new Date(TO).toISOString() },
  market: '10 Minutes - 1X2 (Draw)',
  target: TARGET,
  combinedOdds: product,
  note: 'Preview only. No stake entered and no bet placed.',
  legs: legs.map(l => ({ fixtureId: l.fixtureId, game: l.game, league: l.league, kickoff: l.kickoff, market: 'DRAW10MIN', outcome: 'Draw (first 10 min)', odds: l.odds, trueProb: l.trueProb, rawMarketId: '105', rawSpecifier: 'from=1|to=10', rawOutcomeId: '2' })),
}
writeFileSync(OUT, JSON.stringify(ticket, null, 2))
console.log(`\nWrote ${OUT}`)

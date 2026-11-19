/**
 * scripts/cook-handicap-slip.mjs — safest-first cooker restricted to the Asian Handicap
 * market (marketId 16). Per fixture, scans every offered line (-0.5, -1, -1.5, -2, ...) for
 * whichever favorite side clears MIN_ODDS with the highest true probability — i.e. the
 * deepest handicap line that's still worth backing, not just the shallowest -0.5.
 *
 * Usage:
 *   node scripts/cook-handicap-slip.mjs --target=5 --toISO=2026-09-01T13:00:00Z --out=slip-hcp.json
 */
import { writeFileSync } from 'node:fs'

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const MIN_ODDS = 1.20

const arg = (name, fallback = null) => {
  const found = process.argv.find(x => x.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const TARGET = Number(arg('target', '5'))
const OUT = arg('out', 'slip-hcp.json')
const FROM = Date.now()
const TO = arg('toISO') ? new Date(arg('toISO')).getTime() : Date.now() + Number(arg('hours', '24')) * 3600 * 1000

const isSimulated = (t, ev) => /simulat/i.test(t.category?.name || '') || /\bsrl\b/i.test(ev.homeTeamName || '') || /\bsrl\b/i.test(ev.awayTeamName || '')

console.log(`Window: ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()}`)
console.log(`Market: Handicap — deepest line per game that still clears ${MIN_ODDS} odds`)
console.log(`Target combined odds: ${TARGET}x`)

const all = []
for (let pg = 1; pg <= 20; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=16&pageSize=100&pageNum=${pg}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) {
    for (const ev of t.events || []) {
      pageEvents++
      if (isSimulated(t, ev)) continue
      if (ev.estimateStartTime < FROM || ev.estimateStartTime > TO) continue
      const lines = (ev.markets || []).filter(m => m.id === '16' && (m.status === undefined || m.status === 0))
      const candidates = []
      for (const line of lines) {
        const home = line.outcomes.find(o => /^home/i.test(o.desc))
        const away = line.outcomes.find(o => /^away/i.test(o.desc))
        for (const o of [home, away]) {
          if (o?.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ desc: o.desc, side: o === home ? ev.homeTeamName : ev.awayTeamName, odds: +o.odds, trueProb: +o.probability, specifier: line.specifier, outcomeId: o.id })
        }
      }
      if (!candidates.length) continue
      const best = candidates.sort((a, b) => b.trueProb - a.trueProb)[0]
      all.push({
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        league: t.name,
        kickoff: new Date(ev.estimateStartTime).toISOString(),
        kickoffMs: ev.estimateStartTime,
        odds: best.odds,
        trueProb: best.trueProb,
        outcome: `${best.desc} [${best.side}]`,
        rawMarketId: '16',
        rawSpecifier: best.specifier,
        rawOutcomeId: best.outcomeId,
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

console.log(`\nCooked Handicap slip — ${legs.length} legs, combined odds ${product.toFixed(2)}x`)
for (const l of legs) console.log(`[${l.league}] ${l.kickoff}  ${l.game} -> ${l.outcome} (${l.rawSpecifier}) @ ${l.odds} (${(l.trueProb * 100).toFixed(1)}%)`)

const combinedProb = legs.reduce((p, l) => p * l.trueProb, 1)
console.log(`\nCombined true probability: ${(combinedProb * 100).toFixed(2)}%`)

const ticket = {
  generatedAt: new Date().toISOString(),
  window: { fromISO: new Date(FROM).toISOString(), toISO: new Date(TO).toISOString() },
  market: 'Handicap (deepest safe line per game)',
  target: TARGET,
  combinedOdds: product,
  combinedTrueProbability: combinedProb,
  note: 'Preview only. No stake entered and no bet placed.',
  legs,
}
writeFileSync(OUT, JSON.stringify(ticket, null, 2))
console.log(`\nWrote ${OUT}`)

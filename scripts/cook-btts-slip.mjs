/**
 * scripts/cook-btts-slip.mjs — safest-first cooker restricted to markets that genuinely
 * involve BOTH teams (Over 1.5 total goals, and BTTS Yes/No — whichever side is safer),
 * explicitly excluding DNB/1X2 (one team's result) and Under 4.5. Picks the single best
 * of those per fixture, ranks by true probability, greedily accumulates to target odds.
 *
 * Usage:
 *   node scripts/cook-btts-slip.mjs --target=5 --toISO=2026-09-01T13:00:00Z --out=slip.json
 */
import { writeFileSync } from 'node:fs'

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const MIN_ODDS = 1.20

const arg = (name, fallback = null) => {
  const found = process.argv.find(x => x.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const TARGET = Number(arg('target', '5'))
const OUT = arg('out', 'slip-bothteams.json')
const FROM = Date.now()
const TO = arg('toISO') ? new Date(arg('toISO')).getTime() : Date.now() + Number(arg('hours', '24')) * 3600 * 1000

const isSimulated = (t, ev) => /simulat/i.test(t.category?.name || '') || /\bsrl\b/i.test(ev.homeTeamName || '') || /\bsrl\b/i.test(ev.awayTeamName || '')

console.log(`Window: ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()}`)
console.log(`Markets: Over 1.5, BTTS Yes/No (whichever is safer per game) — no DNB/1X2/Under`)
console.log(`Target combined odds: ${TARGET}x`)

const all = []
for (let pg = 1; pg <= 20; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=18,29&pageSize=100&pageNum=${pg}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) {
    for (const ev of t.events || []) {
      pageEvents++
      if (isSimulated(t, ev)) continue
      if (ev.estimateStartTime < FROM || ev.estimateStartTime > TO) continue
      const candidates = []
      const o15 = (ev.markets || []).find(m => m.id === '18' && m.specifier === 'total=1.5' && (m.status === undefined || m.status === 0))
      if (o15) { const o = o15.outcomes.find(x => /^over/i.test(x.desc)); if (o?.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ market: 'O15', outcome: 'Over 1.5', odds: +o.odds, trueProb: +o.probability, rawMarketId: '18', rawSpecifier: 'total=1.5', rawOutcomeId: '12' }) }
      const btts = (ev.markets || []).find(m => m.id === '29' && (m.status === undefined || m.status === 0))
      if (btts) {
        const yes = btts.outcomes.find(o => /^yes/i.test(o.desc))
        const no = btts.outcomes.find(o => /^no/i.test(o.desc))
        const opts = [yes, no].filter(o => o?.isActive === 1 && +o.odds >= MIN_ODDS)
        if (opts.length) { const c = [...opts].sort((a, b) => +a.odds - +b.odds)[0]; candidates.push({ market: 'BTTS', outcome: /^yes/i.test(c.desc) ? 'GG (Yes)' : 'NG (No)', odds: +c.odds, trueProb: +c.probability, rawMarketId: '29', rawSpecifier: '', rawOutcomeId: /^yes/i.test(c.desc) ? '74' : '76' }) }
      }
      if (!candidates.length) continue
      const best = candidates.sort((a, b) => b.trueProb - a.trueProb)[0]
      all.push({
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        league: t.name,
        kickoff: new Date(ev.estimateStartTime).toISOString(),
        kickoffMs: ev.estimateStartTime,
        ...best,
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

console.log(`\nCooked slip — ${legs.length} legs, combined odds ${product.toFixed(2)}x`)
for (const l of legs) console.log(`[${l.league}] ${l.kickoff}  ${l.game} -> ${l.market} ${l.outcome} @ ${l.odds} (${(l.trueProb * 100).toFixed(1)}%)`)

const combinedProb = legs.reduce((p, l) => p * l.trueProb, 1)
console.log(`\nCombined true probability: ${(combinedProb * 100).toFixed(2)}%`)

const ticket = {
  generatedAt: new Date().toISOString(),
  window: { fromISO: new Date(FROM).toISOString(), toISO: new Date(TO).toISOString() },
  target: TARGET,
  combinedOdds: product,
  combinedTrueProbability: combinedProb,
  note: 'Preview only. No stake entered and no bet placed. Only Over 1.5 / BTTS used (both genuinely involve both teams) — no DNB, 1X2, or Under.',
  legs,
}
writeFileSync(OUT, JSON.stringify(ticket, null, 2))
console.log(`\nWrote ${OUT}`)

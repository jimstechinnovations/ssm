/**
 * scripts/cook-highprob-slip.mjs — per fixture, scans EVERY market this session has used
 * (O15/U45/DC/DNB/HCP/1X2, team Over 0.5, DC 1UP, 10-Minute Draw) and keeps only the single
 * safest pick per game, restricted to legs whose true probability is >= minProb. Ranks by
 * probability and greedily accumulates to the target combined odds.
 *
 * Usage:
 *   node scripts/cook-highprob-slip.mjs --target=200 --minProb=0.90 --toISO=2026-08-31T23:00:00Z --out=slip.json
 */
import { writeFileSync } from 'node:fs'

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'

const arg = (name, fallback = null) => {
  const found = process.argv.find(x => x.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const TARGET = Number(arg('target', '200'))
const MIN_PROB = Number(arg('minProb', '0.90'))
const OUT = arg('out', 'slip-highprob.json')
const FROM = Date.now()
const TO = arg('toISO') ? new Date(arg('toISO')).getTime() : Date.now() + Number(arg('hours', '24')) * 3600 * 1000

const isSimulated = (t, ev) => /simulat/i.test(t.category?.name || '') || /\bsrl\b/i.test(ev.homeTeamName || '') || /\bsrl\b/i.test(ev.awayTeamName || '')

console.log(`Window: ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()}`)
console.log(`Min per-leg true probability: ${(MIN_PROB * 100).toFixed(0)}%`)
console.log(`Target combined odds: ${TARGET}x`)

const MARKET_IDS = '1,10,11,16,18,19,20,60110,105'
const byFixture = new Map()

for (let pg = 1; pg <= 20; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=${MARKET_IDS}&pageSize=100&pageNum=${pg}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) {
    for (const ev of t.events || []) {
      pageEvents++
      if (isSimulated(t, ev)) continue
      if (ev.estimateStartTime < FROM || ev.estimateStartTime > TO) continue
      const fixtureId = Number(String(ev.eventId).split(':').pop())
      const game = `${ev.homeTeamName} vs ${ev.awayTeamName}`
      const kickoff = new Date(ev.estimateStartTime).toISOString()
      const candidates = []

      const mk = {}
      for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (mk[m.id] ??= []).push(m) }

      // Over 1.5 / Under 4.5
      const totals = mk['18'] || []
      const o15 = totals.find(m => m.specifier === 'total=1.5')
      if (o15) { const o = o15.outcomes.find(x => /^over/i.test(x.desc)); if (o?.isActive === 1) candidates.push({ market: 'O15', outcome: 'Over 1.5', odds: +o.odds, trueProb: +o.probability, rawMarketId: '18', rawSpecifier: 'total=1.5', rawOutcomeId: '12' }) }
      const u45 = totals.find(m => m.specifier === 'total=4.5')
      if (u45) { const u = u45.outcomes.find(x => /^under/i.test(x.desc)); if (u?.isActive === 1) candidates.push({ market: 'U45', outcome: 'Under 4.5', odds: +u.odds, trueProb: +u.probability, rawMarketId: '18', rawSpecifier: 'total=4.5', rawOutcomeId: '13' }) }

      // Team Over 0.5, whichever side
      const home19 = (mk['19'] || []).find(m => m.specifier === 'total=0.5')
      if (home19) { const o = home19.outcomes.find(x => /^over/i.test(x.desc)); if (o?.isActive === 1) candidates.push({ market: 'HOU05', outcome: `${ev.homeTeamName} Over 0.5`, odds: +o.odds, trueProb: +o.probability, rawMarketId: '19', rawSpecifier: 'total=0.5', rawOutcomeId: '12' }) }
      const away20 = (mk['20'] || []).find(m => m.specifier === 'total=0.5')
      if (away20) { const o = away20.outcomes.find(x => /^over/i.test(x.desc)); if (o?.isActive === 1) candidates.push({ market: 'AOU05', outcome: `${ev.awayTeamName} Over 0.5`, odds: +o.odds, trueProb: +o.probability, rawMarketId: '20', rawSpecifier: 'total=0.5', rawOutcomeId: '12' }) }

      // Double Chance (cheapest of 3)
      const dc = (mk['10'] || [])[0]
      if (dc) {
        const opts = (dc.outcomes || []).filter(o => o.isActive === 1 && +o.odds > 1)
        if (opts.length) { const c = [...opts].sort((a, b) => +a.odds - +b.odds)[0]; candidates.push({ market: 'DC', outcome: c.desc, odds: +c.odds, trueProb: +c.probability, rawMarketId: '10', rawSpecifier: '', rawOutcomeId: c.id }) }
      }

      // DNB
      const dnb = (mk['11'] || [])[0]
      if (dnb) {
        const home = dnb.outcomes.find(o => /^home/i.test(o.desc)), away = dnb.outcomes.find(o => /^away/i.test(o.desc))
        if (home?.isActive === 1 && away?.isActive === 1) {
          const fav = +home.odds <= +away.odds ? { o: home, id: '4' } : { o: away, id: '5' }
          candidates.push({ market: 'DNB', outcome: fav.o.desc, odds: +fav.o.odds, trueProb: +fav.o.probability, rawMarketId: '11', rawSpecifier: '', rawOutcomeId: fav.id })
        }
      }

      // DC 1UP
      const dc1up = (mk['60110'] || [])[0]
      if (dc1up) {
        const opts = (dc1up.outcomes || []).filter(o => o.isActive === 1 && +o.odds > 1)
        if (opts.length) { const c = [...opts].sort((a, b) => +a.odds - +b.odds)[0]; candidates.push({ market: 'DC1UP', outcome: c.desc + ' (1UP)', odds: +c.odds, trueProb: +c.probability, rawMarketId: '60110', rawSpecifier: '', rawOutcomeId: c.id }) }
      }

      // 10-Minute Draw
      const min10 = (mk['105'] || []).find(m => m.specifier === 'from=1|to=10')
      if (min10) { const d = min10.outcomes.find(x => /^draw/i.test(x.desc)); if (d?.isActive === 1) candidates.push({ market: 'DRAW10', outcome: 'Draw (10 min)', odds: +d.odds, trueProb: +d.probability, rawMarketId: '105', rawSpecifier: 'from=1|to=10', rawOutcomeId: '2' }) }

      if (!candidates.length) continue
      const best = candidates.sort((a, b) => b.trueProb - a.trueProb)[0]
      if (best.trueProb < MIN_PROB) continue
      byFixture.set(fixtureId, { fixtureId, game, league: t.name, kickoff, kickoffMs: ev.estimateStartTime, ...best })
    }
  }
  if (pageEvents === 0 && pg > 8) break
}

const all = [...byFixture.values()].sort((a, b) => b.trueProb - a.trueProb)
console.log(`\n${all.length} fixtures qualify at >=${(MIN_PROB * 100).toFixed(0)}% true probability`)

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
console.log(`\nEvery leg individually: ${(Math.min(...legs.map(l => l.trueProb)) * 100).toFixed(1)}%-${(Math.max(...legs.map(l => l.trueProb)) * 100).toFixed(1)}%`)
console.log(`Combined true probability of ALL legs landing: ${(combinedProb * 100).toFixed(4)}%`)

const ticket = {
  generatedAt: new Date().toISOString(),
  window: { fromISO: new Date(FROM).toISOString(), toISO: new Date(TO).toISOString() },
  minLegProbability: MIN_PROB,
  target: TARGET,
  combinedOdds: product,
  combinedTrueProbability: combinedProb,
  note: 'Preview only. No stake entered and no bet placed. Per-leg probability is 90-95%+; combined probability of the WHOLE slip landing is much lower — see combinedTrueProbability.',
  legs: legs.map(l => ({ fixtureId: l.fixtureId, game: l.game, league: l.league, kickoff: l.kickoff, market: l.market, outcome: l.outcome, odds: l.odds, trueProb: l.trueProb, rawMarketId: l.rawMarketId, rawSpecifier: l.rawSpecifier, rawOutcomeId: l.rawOutcomeId })),
}
writeFileSync(OUT, JSON.stringify(ticket, null, 2))
console.log(`\nWrote ${OUT}`)

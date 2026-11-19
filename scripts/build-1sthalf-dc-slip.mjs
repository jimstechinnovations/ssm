/**
 * scripts/build-1sthalf-dc-slip.mjs — slip using ONLY the 1st Half Double Chance market (id 63:
 * Home-or-Draw / Home-or-Away / Draw-or-Away, first-half result only). For each qualifying fixture,
 * picks whichever of the 3 outcomes is cheapest (most likely), devigged against the other two.
 *
 * Run: node scripts/build-1sthalf-dc-slip.mjs [stake=500] [out=slip.json] --minKickISO= --maxKickISO=
 */
import { writeFileSync } from 'node:fs'

const STAKE = Number(process.argv[2] || 500)
const OUT = process.argv[3] || 'slip-1sthalf-dc.json'
const isoArg = (name) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? new Date(a.split('=')[1]).getTime() : null }
const minKick = isoArg('minKickISO') ?? Date.now()
const maxKick = isoArg('maxKickISO') ?? (Date.now() + 24 * 3600 * 1000)
const MIN_ODDS = 1.05
const SITE_MAX_LEGS = 50

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const countryOf = (ev) => ev.sport?.category?.name || ''
const isSimulated = (ev) => /simulat/i.test(countryOf(ev)) || /\bsrl\b/i.test(ev.homeTeamName) || /\bsrl\b/i.test(ev.awayTeamName)
function marketsById(ev) { const out = {}; for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (out[m.id] ??= []).push(m) }; return out }

console.log(`kickoff window: ${new Date(minKick).toISOString()} .. ${new Date(maxKick).toISOString()}`)
console.log('market: 1st Half Double Chance ONLY (Home-or-Draw / Home-or-Away / Draw-or-Away)')

const rows = []
for (let pg = 1; pg <= 20; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=1,63&pageSize=100&pageNum=${pg}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) {
    for (const ev of t.events || []) {
      pageEvents++
      if (isSimulated(ev)) continue
      if (ev.estimateStartTime < minKick || ev.estimateStartTime > maxKick) continue
      const mk = marketsById(ev)
      const dc63 = (mk['63'] || [])[0]
      if (!dc63) continue
      const opts = (dc63.outcomes || []).filter(o => o.isActive === 1).map(o => ({ id: o.id, desc: o.desc, odds: +o.odds })).filter(o => o.odds > 1)
      if (opts.length !== 3) continue
      const impliedSum = opts.reduce((s, o) => s + 1 / o.odds, 0)
      const cheapest = [...opts].sort((a, b) => a.odds - b.odds)[0]
      const trueProb = (1 / cheapest.odds) / impliedSum
      if (cheapest.odds < MIN_ODDS) continue
      rows.push({
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        league: t.name,
        kickoff: new Date(ev.estimateStartTime).toISOString(),
        outcome: cheapest.desc, odds: cheapest.odds, trueProb, rawOutcomeId: cheapest.id,
      })
    }
  }
  if (pageEvents === 0) break
}

console.log(`\n${rows.length} qualifying fixtures with an active 1st-Half DC market in this window`)
rows.sort((a, b) => b.trueProb - a.trueProb)
if (rows.length > SITE_MAX_LEGS) rows.length = SITE_MAX_LEGS

console.log(`\n===== ${rows.length} legs =====\n`)
for (const r of rows) console.log(`${r.game} (${r.kickoff}) — 1H ${r.outcome} @ ${r.odds} (${(r.trueProb * 100).toFixed(1)}%)`)

const combinedOdds = rows.reduce((p, r) => p * r.odds, 1)
const trueProb = rows.reduce((p, r) => p * r.trueProb, 1)
const legs = rows.map(r => ({ fixtureId: r.fixtureId, game: r.game, league: r.league, market: 'DC1H', outcome: r.outcome, odds: r.odds, rawMarketId: '63', rawSpecifier: '', rawOutcomeId: r.rawOutcomeId }))
const slip = { stake: STAKE, legs, combinedOdds, trueProb, potentialPayout: Math.round(combinedOdds * STAKE) }
writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), slips: [slip] }, null, 1))

console.log(`\n===== ${OUT}: ${rows.length} legs, combined odds ${combinedOdds.toFixed(2)}, trueProb ${(trueProb * 100).toFixed(3)}%, payout ₦${slip.potentialPayout} =====`)

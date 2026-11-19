/**
 * scripts/build-1sthalf-over05-slip.mjs — slip using ONLY "1st Half Over 0.5" (market 68,
 * specifier total=0.5, outcome side fixed to Over — at least one goal in the first 45 minutes).
 *
 * Run: node scripts/build-1sthalf-over05-slip.mjs [oddsCap=200] [stake=500] [out=slip.json] --minKickISO= --maxKickISO=
 */
import { writeFileSync } from 'node:fs'

const ODDS_CAP = Number(process.argv[2] || 200)
const STAKE = Number(process.argv[3] || 500)
const OUT = process.argv[4] || 'slip-1sthalf-over05.json'
const isoArg = (name) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? new Date(a.split('=')[1]).getTime() : null }
const minKick = isoArg('minKickISO') ?? (Date.now() + 3 * 3600 * 1000)
const maxKick = isoArg('maxKickISO') ?? (Date.now() + 24 * 3600 * 1000)
const MIN_ODDS = 1.05
const SITE_MAX_LEGS = 50

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const devig = (a, b) => { const ia = 1 / a, ib = 1 / b, s = ia + ib; return { pA: ia / s, pB: ib / s, margin: s - 1 } }
const countryOf = (ev) => ev.sport?.category?.name || ''
const isSimulated = (ev) => /simulat/i.test(countryOf(ev)) || /\bsrl\b/i.test(ev.homeTeamName) || /\bsrl\b/i.test(ev.awayTeamName)
function marketsById(ev) { const out = {}; for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (out[m.id] ??= []).push(m) }; return out }

console.log(`kickoff window: ${new Date(minKick).toISOString()} .. ${new Date(maxKick).toISOString()}`)
console.log('market: 1st Half Over 0.5 ONLY')

const rows = []
for (let pg = 1; pg <= 20; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=1,68&pageSize=100&pageNum=${pg}`
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
      const line = (mk['68'] || []).find(m => m.specifier === 'total=0.5')
      if (!line) continue
      const over = line.outcomes.find(o => /^over/i.test(o.desc)), under = line.outcomes.find(o => /^under/i.test(o.desc))
      if (!over || !under || over.isActive !== 1 || under.isActive !== 1) continue
      if (+over.odds < MIN_ODDS) continue
      const { pA: trueProb } = devig(+over.odds, +under.odds)
      rows.push({
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        league: t.name,
        kickoff: new Date(ev.estimateStartTime).toISOString(),
        outcome: over.desc, odds: +over.odds, trueProb,
      })
    }
  }
  if (pageEvents === 0) break
}

console.log(`\n${rows.length} qualifying fixtures with an active 1st-Half Over 0.5 market in this window`)
rows.sort((a, b) => b.trueProb - a.trueProb)

const base = []
let prod = 1
for (const r of rows) {
  if (base.length >= SITE_MAX_LEGS) break
  const next = prod * r.odds
  if (base.length > 0 && next > ODDS_CAP) break
  base.push(r)
  prod = next
  if (next > ODDS_CAP) break
}
if (base.length === 0) { console.error('No qualifying fixtures found.'); process.exit(1) }

console.log(`\n===== ${base.length} legs =====\n`)
for (const r of base) console.log(`${r.game} (${r.kickoff}) — 1H ${r.outcome} @ ${r.odds} (${(r.trueProb * 100).toFixed(1)}%)`)

const combinedOdds = base.reduce((p, r) => p * r.odds, 1)
const trueProb = base.reduce((p, r) => p * r.trueProb, 1)
const legs = base.map(r => ({ fixtureId: r.fixtureId, game: r.game, league: r.league, market: 'OU0.5_1H', outcome: r.outcome, odds: r.odds, rawMarketId: '68', rawSpecifier: 'total=0.5', rawOutcomeId: '12' }))
const slip = { stake: STAKE, legs, combinedOdds, trueProb, potentialPayout: Math.round(combinedOdds * STAKE) }
writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), slips: [slip] }, null, 1))

console.log(`\n===== ${OUT}: ${base.length} legs, combined odds ${combinedOdds.toFixed(2)}, trueProb ${(trueProb * 100).toFixed(3)}%, payout ₦${slip.potentialPayout} =====`)

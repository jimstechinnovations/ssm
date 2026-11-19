/**
 * scripts/build-correctscore-slip.mjs — slip using ONLY the Correct Score market (id 45: every
 * specific scoreline 0:0/1:0/.../"Other", N-way). For each fixture, picks whichever scoreline is
 * cheapest (most likely), devigged against the full outcome set. Auto-fits the base pool (safest
 * legs first) up to oddsCap, same greedy pattern as the other builders.
 *
 * Correct Score is a genuinely low-probability-per-leg market (even the modal scoreline in a lopsided
 * favourite is rarely much above ~20-25%) — this is inherently the riskiest market type we build for,
 * flagged honestly rather than dressed up.
 *
 * Run: node scripts/build-correctscore-slip.mjs [oddsCap=3000] [stake=500] [out=slip.json] --minKickISO= --maxKickISO=
 */
import { writeFileSync } from 'node:fs'

const ODDS_CAP = Number(process.argv[2] || 3000)
const STAKE = Number(process.argv[3] || 500)
const OUT = process.argv[4] || 'slip-correctscore.json'
const isoArg = (name) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? new Date(a.split('=')[1]).getTime() : null }
const minKick = isoArg('minKickISO') ?? (Date.now() + 3 * 3600 * 1000)
const maxKick = isoArg('maxKickISO') ?? (Date.now() + 24 * 3600 * 1000)
const SITE_MAX_LEGS = 50

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const countryOf = (ev) => ev.sport?.category?.name || ''
const isSimulated = (ev) => /simulat/i.test(countryOf(ev)) || /\bsrl\b/i.test(ev.homeTeamName) || /\bsrl\b/i.test(ev.awayTeamName)
function marketsById(ev) { const out = {}; for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (out[m.id] ??= []).push(m) }; return out }

console.log(`kickoff window: ${new Date(minKick).toISOString()} .. ${new Date(maxKick).toISOString()}`)
console.log('market: Correct Score ONLY — inherently low probability per leg, flagged honestly below')

const rows = []
for (let pg = 1; pg <= 20; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=1,45&pageSize=100&pageNum=${pg}`
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
      const cs = (mk['45'] || [])[0]
      if (!cs) continue
      const opts = (cs.outcomes || []).filter(o => o.isActive === 1).map(o => ({ id: o.id, desc: o.desc, odds: +o.odds })).filter(o => o.odds > 1)
      if (opts.length < 2) continue
      const impliedSum = opts.reduce((s, o) => s + 1 / o.odds, 0)
      const cheapest = [...opts].sort((a, b) => a.odds - b.odds)[0]
      const trueProb = (1 / cheapest.odds) / impliedSum
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

console.log(`\n${rows.length} qualifying fixtures with an active Correct Score market in this window`)
rows.sort((a, b) => b.trueProb - a.trueProb)

// Correct Score legs carry much higher individual odds (3-5x+) than the other markets, so the usual
// "stop before exceeding the cap" rule can land WAY under target (e.g. 938x when asked for 3000x)
// since the next leg alone might jump from 900x to 4000x — no leg in between. When that happens, take
// whichever of {stop here, take one more} lands closer to ODDS_CAP in ratio terms, not just under it.
const base = []
let prod = 1
for (const r of rows) {
  if (base.length >= SITE_MAX_LEGS) break
  const next = prod * r.odds
  if (base.length > 0 && next > ODDS_CAP) {
    const underDist = Math.abs(Math.log(ODDS_CAP / prod))
    const overDist = Math.abs(Math.log(next / ODDS_CAP))
    if (overDist < underDist) { base.push(r); prod = next }
    break
  }
  base.push(r)
  prod = next
  if (next > ODDS_CAP) break
}
if (base.length === 0) { console.error('No qualifying fixtures found.'); process.exit(1) }

console.log(`\n===== ${base.length} legs =====\n`)
for (const r of base) console.log(`${r.game} (${r.kickoff}) — Correct Score ${r.outcome} @ ${r.odds} (${(r.trueProb * 100).toFixed(1)}%)`)

const combinedOdds = base.reduce((p, r) => p * r.odds, 1)
const trueProb = base.reduce((p, r) => p * r.trueProb, 1)
const legs = base.map(r => ({ fixtureId: r.fixtureId, game: r.game, league: r.league, market: 'CS', outcome: r.outcome, odds: r.odds, rawMarketId: '45', rawSpecifier: '', rawOutcomeId: r.rawOutcomeId }))
const slip = { stake: STAKE, legs, combinedOdds, trueProb, potentialPayout: Math.round(combinedOdds * STAKE) }
writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), slips: [slip] }, null, 1))

console.log(`\n===== ${OUT}: ${base.length} legs, combined odds ${combinedOdds.toFixed(2)}, trueProb ${(trueProb * 100).toFixed(4)}%, payout ₦${slip.potentialPayout} =====`)

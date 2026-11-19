/**
 * scripts/build-live-multimarket-slip.mjs — LIVE (in-play) version of the multi-market picker.
 *
 * Genuinely different from the pre-match builder, not just a copy:
 *   - Fetches liveOrPrematchEvents?productId=2 (in-play feed), not pcUpcomingEvents.
 *   - NO history/form-model blending. A team's season-long form is close to irrelevant against
 *     "it's 1-0 with 20 minutes left" — the live book price already encodes the current score and
 *     time remaining, which is a far sharper signal than pre-match form. Blending stale historical
 *     form into a live price would be dishonest, not just unhelpful.
 *   - Requires outcome-level isActive===1 (not just market.status===0) — live markets flicker
 *     in/out of tradeable state constantly (e.g. right after a goal while prices recalculate).
 *   - Skips matches very close to full time (default: only "1st half"/"2nd half" main-time states,
 *     not stoppage-heavy or finished states) since odds go degenerate (e.g. Over 0.5 @ 1.01) and
 *     add nothing but leg count.
 *   - LIVE ODDS MOVE FAST. Build this, generate+verify the booking code, and place it in one quick
 *     sequence — don't let minutes pass between steps the way pre-match builds tolerate.
 *
 * Run: node scripts/build-live-multimarket-slip.mjs [oddsCap=200] [slips=1] [stake=500] [out=live-slip.json] [--minOdds=1.20]
 */
import { writeFileSync } from 'node:fs'

const ODDS_CAP = Number(process.argv[2] || 200)
const K = Number(process.argv[3] || 1)
const STAKE = Number(process.argv[4] || 500)
const OUT = process.argv[5] || 'live-slip.json'
const minOddsArg = process.argv.find(x => x.startsWith('--minOdds='))
const MIN_ODDS = minOddsArg ? Number(minOddsArg.split('=')[1]) : 1.20
const SITE_MAX_LEGS = 50

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/liveOrPrematchEvents'
const devig = (a, b) => { const ia = 1 / a, ib = 1 / b, s = ia + ib; return { pA: ia / s, pB: ib / s, margin: s - 1 } }
const devig3 = (h, d, a) => { const ih = 1 / h, id = 1 / d, ia = 1 / a, s = ih + id + ia; return { pH: ih / s, pD: id / s, pA: ia / s, margin: s - 1 } }
const countryOf = (ev) => ev.sport?.category?.name || ''
const isSimulated = (ev) => /simulat/i.test(countryOf(ev)) || /\bsrl\b/i.test(ev.homeTeamName) || /\bsrl\b/i.test(ev.awayTeamName)
const RISKY_LEAGUE_RE = /^J2 League$|^J3 League$|Serie C|Eerste Divisie|Liga de Expansion|^Ettan$|A-League, Women|Eredivisie, Women|Super League( 2)?, Women|Tercera Federacion|Promotion d.Honneur|^2\. Liga$|Primera Division, Women|Premier League, Women|U20|U19|U21|Reserves?/
const RISKY_TEAM_RE = /\bU(1[6-9]|2[0-3])\b|\bReserve(s)?\b/i

// Only main-time states — avoid stoppage/extra-time/finished states where odds go degenerate.
const OK_STATUS = /^(H1|H2)$/
// A leading side only clears the "straight win" bar if the lead looks safe to hold, not just ahead right now.
function comfortableLead(ev, favIsHome) {
  const [h, a] = String(ev.setScore || '0:0').split(':').map(Number)
  const diff = favIsHome ? h - a : a - h
  if (diff <= 0) return false
  if (diff >= 2) return true
  const mins = parseInt(String(ev.playedSeconds || '0').split(':')[0], 10) || 0
  return ev.matchStatus === 'H2' && mins >= 75
}
function marketsById(ev) {
  const out = {}
  for (const m of ev.markets || []) { if (m.status !== 0) continue; (out[m.id] ??= []).push(m) }
  return out
}

function bestLeg(ev) {
  const mk = marketsById(ev)
  const candidates = []
  const active = (o) => o && o.isActive === 1

  // Scan EVERY posted Over/Under line (0.5, 1.5, 2.5, 3.5, 4.5, 5.5, ...), not just fixed 1.5/4.5.
  // Whichever side of whichever line is most probable right now wins its own candidate slot — this
  // way a line getting suspended (near-lock, isActive:0) doesn't force a fallback onto some other
  // line's weaker side; the next-best line just takes over naturally.
  const ouLines = (mk['18'] || []).filter(m => /^total=/.test(m.specifier || ''))
  for (const line of ouLines) {
    const u = line.outcomes.find(o => /^under/i.test(o.desc)), o = line.outcomes.find(x => /^over/i.test(x.desc))
    if (!active(u) || !active(o)) continue
    const { pA, pB, margin } = devig(+u.odds, +o.odds)
    const lineNum = line.specifier.split('=')[1]
    const pick = pA >= pB ? { desc: `Under ${lineNum}`, odds: +u.odds, p: pA, id: u.id } : { desc: `Over ${lineNum}`, odds: +o.odds, p: pB, id: o.id }
    if (pick.odds >= MIN_ODDS) candidates.push({ market: `OU${lineNum}`, outcome: pick.desc, odds: pick.odds, trueProb: pick.p, margin, rawMarketId: '18', rawSpecifier: line.specifier, rawOutcomeId: pick.id })
  }
  const dc = (mk['10'] || [])[0]
  if (dc) {
    const opts = (dc.outcomes || []).filter(active).map(o => ({ desc: o.desc, odds: +o.odds, id: o.id })).filter(o => o.odds > 1)
    if (opts.length === 3) {
      const impliedSum = opts.reduce((s, o) => s + 1 / o.odds, 0)
      const cheapest = [...opts].sort((a, b) => a.odds - b.odds)[0]
      if (cheapest.odds >= MIN_ODDS) candidates.push({ market: 'DC', outcome: cheapest.desc, odds: cheapest.odds, trueProb: (1 / cheapest.odds) / impliedSum, margin: impliedSum - 1, rawMarketId: '10', rawSpecifier: '', rawOutcomeId: cheapest.id })
    }
  }
  const dnb = (mk['11'] || [])[0]
  if (dnb) {
    const home = dnb.outcomes.find(o => /^home/i.test(o.desc)), away = dnb.outcomes.find(o => /^away/i.test(o.desc))
    if (active(home) && active(away)) {
      const { pA, pB, margin } = devig(+home.odds, +away.odds)
      const fav = +home.odds <= +away.odds ? { desc: 'Home (DNB)', odds: +home.odds, p: pA, id: home.id } : { desc: 'Away (DNB)', odds: +away.odds, p: pB, id: away.id }
      if (fav.odds >= MIN_ODDS) candidates.push({ market: 'DNB', outcome: fav.desc, odds: fav.odds, trueProb: fav.p, margin, rawMarketId: '11', rawSpecifier: '', rawOutcomeId: fav.id })
    }
  }
  const x12 = (mk['1'] || [])[0]
  if (x12) {
    const home = x12.outcomes.find(o => /^home/i.test(o.desc)), draw = x12.outcomes.find(o => /^draw/i.test(o.desc)), away = x12.outcomes.find(o => /^away/i.test(o.desc))
    if (active(home) && active(draw) && active(away)) {
      const { pH, pA } = devig3(+home.odds, +draw.odds, +away.odds)
      const favIsHome = pH >= pA
      const fav = favIsHome ? { desc: `Home [${ev.homeTeamName}]`, odds: +home.odds, p: pH, id: home.id } : { desc: `Away [${ev.awayTeamName}]`, odds: +away.odds, p: pA, id: away.id }
      // Straight win only — allowed here only when the leg is already a comfortable, not a precarious, lead.
      if (fav.odds >= MIN_ODDS && comfortableLead(ev, favIsHome)) candidates.push({ market: '1X2', outcome: fav.desc, odds: fav.odds, trueProb: fav.p, margin: (1/+home.odds+1/+draw.odds+1/+away.odds)-1, rawMarketId: '1', rawSpecifier: '', rawOutcomeId: fav.id })
    }
  }
  const hcpLines = mk['16'] || []
  if (x12 && hcpLines.length) {
    const home = x12.outcomes.find(o => /^home/i.test(o.desc)), away = x12.outcomes.find(o => /^away/i.test(o.desc))
    if (home && away) {
      const favIsHome = +home.odds <= +away.odds
      const half = hcpLines.find(m => m.specifier === (favIsHome ? 'hcp=-0.5' : 'hcp=0.5'))
      if (half) {
        const favDesc = favIsHome ? /^home/i : /^away/i
        const favOut = half.outcomes.find(o => favDesc.test(o.desc) && /\(-0\.5\)/.test(o.desc))
        const dogOut = half.outcomes.find(o => !favDesc.test(o.desc))
        if (active(favOut) && active(dogOut)) {
          const { pA, margin } = devig(+favOut.odds, +dogOut.odds)
          if (+favOut.odds >= MIN_ODDS) candidates.push({ market: 'HCP', outcome: `${favOut.desc} [${favIsHome ? ev.homeTeamName : ev.awayTeamName}]`, odds: +favOut.odds, trueProb: pA, margin, rawMarketId: '16', rawSpecifier: half.specifier, rawOutcomeId: favOut.id })
        }
      }
    }
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => b.trueProb - a.trueProb)
  return candidates
}

console.log('fetching LIVE in-play events...')
const rows = []
for (let pg = 1; pg <= 10; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&productId=2&pageSize=100&pageNum=${pg}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.length) break
  let pageEvents = 0
  for (const t of json.data) {
    for (const ev of t.events || []) {
      pageEvents++
      if (isSimulated(ev)) continue
      if (RISKY_LEAGUE_RE.test(t.name) || RISKY_TEAM_RE.test(ev.homeTeamName) || RISKY_TEAM_RE.test(ev.awayTeamName)) continue
      if (!OK_STATUS.test(ev.matchStatus || '')) continue // skip extra-time/stoppage/finished/etc.
      const candidates = bestLeg(ev)
      if (!candidates) continue
      rows.push({
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        league: t.name,
        liveState: `${ev.matchStatus} ${ev.playedSeconds || ''} score ${ev.setScore || ''}`.trim(),
        picked: candidates[0],
        runnerUp: candidates[1] ?? null,
      })
    }
  }
  if (pageEvents === 0) break
}
// live pagination overlaps/re-sorts between page fetches as odds update — dedupe by fixtureId
// (keep the LAST-seen copy, i.e. freshest odds, since later pages were fetched more recently).
const byFixture = new Map()
for (const r of rows) byFixture.set(r.fixtureId, r)
const deduped = [...byFixture.values()]
console.log(`${rows.length} raw rows -> ${deduped.length} unique live fixtures with a qualifying candidate`)
rows.length = 0; rows.push(...deduped)
rows.sort((a, b) => b.picked.trueProb - a.picked.trueProb)

const base = []
let prod = 1
for (const r of rows) {
  if (base.length >= SITE_MAX_LEGS) break
  const next = prod * r.picked.odds
  if (base.length > 0 && next > ODDS_CAP) break
  base.push(r)
  prod = next
  if (next > ODDS_CAP) break
}
if (base.length === 0) {
  console.error('No qualifying live fixtures found — market may be quiet right now.')
  process.exit(1)
}

console.log(`\n===== LIVE ANALYSIS: ${base.length} legs (book price only — no history blend) =====\n`)
for (const r of base) console.log(`[${r.picked.market}] ${r.game} (${r.liveState}) — ${r.picked.outcome} @ ${r.picked.odds} (${(r.picked.trueProb * 100).toFixed(1)}%)`)

function slipFromBase(legs) {
  const combinedOdds = legs.reduce((p, l) => p * l.picked.odds, 1)
  const trueProb = legs.reduce((p, l) => p * l.picked.trueProb, 1)
  return {
    stake: STAKE,
    legs: legs.map(l => ({ fixtureId: l.fixtureId, game: l.game, league: l.league, market: l.picked.market, outcome: l.picked.outcome, odds: l.picked.odds, rawMarketId: l.picked.rawMarketId, rawSpecifier: l.picked.rawSpecifier, rawOutcomeId: l.picked.rawOutcomeId })),
    combinedOdds, trueProb, potentialPayout: Math.round(combinedOdds * STAKE),
  }
}
const slips = [slipFromBase(base)]
writeFileSync(OUT, JSON.stringify({ oddsCap: ODDS_CAP, stake: STAKE, live: true, builtAt: new Date().toISOString(), slips }, null, 1))

console.log(`\n===== ${OUT}: ${base.length} legs, LIVE slip =====\n`)
const s = slips[0]
console.log(`combined odds ${s.combinedOdds.toFixed(2)}, trueProb ${(s.trueProb * 100).toFixed(3)}%, payout ₦${s.potentialPayout}`)
console.log(`\n*** LIVE ODDS MOVE FAST — generate the booking code and place within the next minute or two, not later. ***`)

/**
 * scripts/build-disjoint-multimarket-slips.mjs — build TWO independent 200x-capped slips from
 * DISJOINT fixture pools (no shared games between them), so a single busted leg can't kill both
 * slips at once the way it did when slip 1/2 shared the same base legs earlier in this session.
 *
 * Same 5-market best-of picker (U45/O15/DC/DNB/HCP) + suspended-market filtering + auto-fit-to-cap
 * as build-multimarket-pedla-book.mjs, just run twice against non-overlapping fixture sets.
 *
 * Run: node scripts/build-disjoint-multimarket-slips.mjs [oddsCap=200] [stake=500] [out=disjoint-book.json] [--minKickISO=] [--maxKickISO=]
 */
import { writeFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas, formProbFor } from './lib-form-model.mjs'

const BOOK_WEIGHT = 0.6, FORM_WEIGHT = 0.4
const MIN_GAMES_FOR_FORM = 3

const ODDS_CAP = Number(process.argv[2] || 200)
const STAKE = Number(process.argv[3] || 500)
const OUT = process.argv[4] || 'disjoint-book.json'
const isoArg = (name) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? new Date(a.split('=')[1]).getTime() : null }
const minKick = isoArg('minKickISO') ?? (Date.now() + 20 * 60 * 1000)
const maxKick = isoArg('maxKickISO') ?? (Date.now() + 24 * 3600 * 1000)
console.log(`kickoff window: ${new Date(minKick).toISOString()} .. ${new Date(maxKick).toISOString()}`)

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const MARKETS = '1,10,11,16,18'
const MIN_ODDS = 1.20

const devig = (a, b) => { const ia = 1 / a, ib = 1 / b, s = ia + ib; return { pA: ia / s, pB: ib / s, margin: s - 1 } }
const devig3 = (h, d, a) => { const ih = 1 / h, id = 1 / d, ia = 1 / a, s = ih + id + ia; return { pH: ih / s, pD: id / s, pA: ia / s, margin: s - 1 } }
function marketsById(ev) { const out = {}; for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (out[m.id] ??= []).push(m) }; return out }

function bestLeg(ev) {
  const mk = marketsById(ev)
  const candidates = []
  const ou = (mk['18'] || []).find(m => m.specifier === 'total=4.5')
  if (ou) {
    const u = ou.outcomes.find(o => /^under/i.test(o.desc)), o = ou.outcomes.find(x => /^over/i.test(x.desc))
    if (u && o) { const { pA, margin } = devig(+u.odds, +o.odds); if (+u.odds >= MIN_ODDS) candidates.push({ market: 'U45', outcome: 'Under 4.5', odds: +u.odds, trueProb: pA, margin }) }
  }
  const ou15 = (mk['18'] || []).find(m => m.specifier === 'total=1.5')
  if (ou15) {
    const u = ou15.outcomes.find(o => /^under/i.test(o.desc)), o = ou15.outcomes.find(x => /^over/i.test(x.desc))
    if (u && o) { const { pB, margin } = devig(+u.odds, +o.odds); if (+o.odds >= MIN_ODDS) candidates.push({ market: 'O15', outcome: 'Over 1.5', odds: +o.odds, trueProb: pB, margin }) }
  }
  const dc = (mk['10'] || [])[0]
  if (dc) {
    const opts = (dc.outcomes || []).map(o => ({ desc: o.desc, odds: +o.odds })).filter(o => o.odds > 1)
    if (opts.length === 3) {
      const impliedSum = opts.reduce((s, o) => s + 1 / o.odds, 0)
      const cheapest = [...opts].sort((a, b) => a.odds - b.odds)[0]
      if (cheapest.odds >= MIN_ODDS) candidates.push({ market: 'DC', outcome: cheapest.desc, odds: cheapest.odds, trueProb: (1 / cheapest.odds) / impliedSum, margin: impliedSum - 1 })
    }
  }
  const dnb = (mk['11'] || [])[0]
  if (dnb) {
    const home = dnb.outcomes.find(o => /^home/i.test(o.desc)), away = dnb.outcomes.find(o => /^away/i.test(o.desc))
    if (home && away) {
      const { pA, pB, margin } = devig(+home.odds, +away.odds)
      const fav = +home.odds <= +away.odds ? { desc: 'Home (DNB)', odds: +home.odds, p: pA } : { desc: 'Away (DNB)', odds: +away.odds, p: pB }
      if (fav.odds >= MIN_ODDS) candidates.push({ market: 'DNB', outcome: fav.desc, odds: fav.odds, trueProb: fav.p, margin })
    }
  }
  const x12 = (mk['1'] || [])[0]
  if (x12) {
    const home = x12.outcomes.find(o => /^home/i.test(o.desc)), draw = x12.outcomes.find(o => /^draw/i.test(o.desc)), away = x12.outcomes.find(o => /^away/i.test(o.desc))
    if (home && draw && away) {
      const { pH, pA } = devig3(+home.odds, +draw.odds, +away.odds)
      const fav = pH >= pA ? { desc: `Home [${ev.homeTeamName}]`, odds: +home.odds, p: pH } : { desc: `Away [${ev.awayTeamName}]`, odds: +away.odds, p: pA }
      if (fav.odds >= MIN_ODDS) candidates.push({ market: '1X2', outcome: fav.desc, odds: fav.odds, trueProb: fav.p, margin: (1/+home.odds+1/+draw.odds+1/+away.odds)-1 })
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
        if (favOut && dogOut) {
          const { pA, margin } = devig(+favOut.odds, +dogOut.odds)
          if (+favOut.odds >= MIN_ODDS) candidates.push({ market: 'HCP', outcome: `${favOut.desc} [${favIsHome ? ev.homeTeamName : ev.awayTeamName}]`, odds: +favOut.odds, trueProb: pA, margin })
        }
      }
    }
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => b.trueProb - a.trueProb)
  return candidates
}

/** Same form-blend as build-multimarket-pedla-book.mjs — kept in sync deliberately (lib-history.mjs
 *  and lib-form-model.mjs are shared, this wrapper just isn't, matching the existing script convention). */
async function enrichRow(row) {
  const bookRanked = [...row.candidates].sort((a, b) => b.trueProb - a.trueProb)
  const [homeRaw, awayRaw] = row.game.split(' vs ')
  const home = homeRaw?.trim(), away = awayRaw?.trim()
  if (!home || !away) return { ...row, picked: bookRanked[0], runnerUp: bookRanked[1] ?? null, formUsed: false }

  const pair = await fetchTeamResultsPair(home, away)
  if (!pair || pair.homeResults.length < MIN_GAMES_FOR_FORM || pair.awayResults.length < MIN_GAMES_FOR_FORM) {
    return { ...row, picked: bookRanked[0], runnerUp: bookRanked[1] ?? null, formUsed: false }
  }

  const lambdas = estimateLambdas(pair.homeResults, pair.awayResults, home, away)
  const blended = row.candidates.map(c => {
    const fp = formProbFor(c.market, lambdas.lambdaHome, lambdas.lambdaAway)
    const formProb = fp == null ? null : (typeof fp === 'number' ? fp : (/^home/i.test(c.outcome) ? fp.pHomeWin : fp.pAwayWin))
    const blendProb = formProb == null ? c.trueProb : BOOK_WEIGHT * c.trueProb + FORM_WEIGHT * formProb
    return { ...c, formProb, blendProb }
  }).sort((a, b) => b.blendProb - a.blendProb)

  const picked = blended[0], runnerUp = blended[1] ?? null, bookPick = bookRanked[0]
  const changed = picked.market !== bookPick.market || picked.outcome !== bookPick.outcome
  return { ...row, picked, runnerUp, formUsed: true, historySource: pair.source, lambdas, changed, bookPick }
}

async function runPool(items, worker, concurrency = 4) {
  const results = new Array(items.length)
  let idx = 0
  async function next() { while (idx < items.length) { const i = idx++; results[i] = await worker(items[i]) } }
  await Promise.all(Array.from({ length: concurrency }, next))
  return results
}

// Country/category lives on the EVENT (ev.sport.category.name), not the tournament grouping object.
const countryOf = (ev) => ev.sport?.category?.name || ''
// Simulated Reality League (category "Simulated Reality League", team names suffixed "SRL"/"Srl") is
// computer-generated fake football using real club names — NOT real matches. Always excluded, no flag.
const isSimulated = (ev) => /simulat/i.test(countryOf(ev)) || /\bsrl\b/i.test(ev.homeTeamName) || /\bsrl\b/i.test(ev.awayTeamName)
const FAMOUS_LEAGUES = [
  'premier league', 'laliga', 'la liga', 'serie a', 'bundesliga', 'ligue 1', 'eredivisie',
  'primeira liga', 'championship', 'süper lig', 'super lig', 'scottish premiership',
  'champions league', 'europa league', 'conference league', 'copa libertadores', 'copa sudamericana',
  'mls', 'liga mx', 'brasileirao', 'brasileiro', 'primera division', 'copa del rey', 'coppa italia',
  'dfb-pokal', 'fa cup', 'league cup', 'community shield', 'world cup', 'euro', 'nations league',
]
const FAMOUS_ONLY = process.argv.includes('--famousOnly')
const isFamous = (t) => FAMOUS_LEAGUES.some(l => (t.name || '').toLowerCase().includes(l))
if (FAMOUS_ONLY) console.log('--famousOnly: restricting to recognised top-tier leagues/competitions')

// ── fetch fixtures once ──
const rows = []
for (let pg = 1; pg <= 8; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=${MARKETS}&pageSize=100&pageNum=${pg}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) {
    if (FAMOUS_ONLY && !isFamous(t)) continue
    for (const ev of t.events || []) {
      pageEvents++
      if (isSimulated(ev)) continue
      if (ev.estimateStartTime < minKick || ev.estimateStartTime > maxKick) continue
      const candidates = bestLeg(ev)
      if (!candidates) continue
      rows.push({
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        league: t.name,
        kickoff: new Date(ev.estimateStartTime).toISOString(),
        candidates,
      })
    }
  }
  if (pageEvents === 0) break
}
console.log(`total qualifying fixtures in window: ${rows.length}`)

console.log(`running form-model check for ${rows.length} fixtures (apifootball + SofaScore fallback)...`)
const enriched = await runPool(rows, enrichRow, 4)
rows.length = 0; rows.push(...enriched)
await closeHistorySession()
const formCount = rows.filter(r => r.formUsed).length
const changedCount = rows.filter(r => r.changed).length
console.log(`form data available for ${formCount}/${rows.length} fixtures; form model CHANGED the pick vs book-only on ${changedCount} of those\n`)

rows.sort((a, b) => (b.picked.blendProb ?? b.picked.trueProb) - (a.picked.blendProb ?? a.picked.trueProb))

// SportyBet hard-caps a betslip at 50 selections — exceeding it silently truncates at placement.
const SITE_MAX_LEGS = 50
function autoFitFromPool(pool, cap) {
  const legs = []
  let prod = 1
  for (const r of pool) {
    if (legs.length >= SITE_MAX_LEGS) break
    const next = prod * r.picked.odds
    if (legs.length > 0 && next > cap) break
    legs.push(r)
    prod = next
    if (next > cap) break
  }
  return legs
}

const slipA = autoFitFromPool(rows, ODDS_CAP)
const usedA = new Set(slipA.map(r => r.fixtureId))
const remaining = rows.filter(r => !usedA.has(r.fixtureId))
const slipB = autoFitFromPool(remaining, ODDS_CAP)

function summarize(legs, stake) {
  const combinedOdds = legs.reduce((p, r) => p * r.picked.odds, 1)
  const trueProb = legs.reduce((p, r) => p * r.picked.trueProb, 1)
  return {
    stake,
    legs: legs.map(r => ({ fixtureId: r.fixtureId, game: r.game, league: r.league, kickoff: r.kickoff, market: r.picked.market, outcome: r.picked.outcome, odds: r.picked.odds })),
    combinedOdds, trueProb, potentialPayout: Math.round(combinedOdds * stake),
  }
}

const A = summarize(slipA, STAKE)
const B = summarize(slipB, STAKE)
const overlap = slipA.filter(r => slipB.some(s => s.fixtureId === r.fixtureId)).length

// ── analysis print: every leg carries a book-vs-form-blended decision (see build-multimarket-pedla-book.mjs). ──
for (const [label, legs] of [['SLIP 1', slipA], ['SLIP 2', slipB]]) {
  console.log(`\n===== ANALYSIS ${label}: ${legs.length} legs =====\n`)
  for (const r of legs) {
    const p = r.picked
    const tag = !r.formUsed ? '(book-only, insufficient history)' : r.changed ? `** CHANGED by form ** (book favoured [${r.bookPick.market}] ${r.bookPick.outcome} @ ${(r.bookPick.trueProb * 100).toFixed(1)}%)` : '(form agrees with book)'
    console.log(`[${p.market}] ${r.game} — ${p.outcome} @ ${p.odds}  book=${(p.trueProb * 100).toFixed(1)}%${r.formUsed ? ` form=${(p.formProb * 100).toFixed(1)}% blend=${(p.blendProb * 100).toFixed(1)}% [${r.historySource}]` : ''} ${tag}`)
  }
}

writeFileSync(OUT, JSON.stringify({ oddsCap: ODDS_CAP, stake: STAKE, disjoint: overlap === 0, slips: [A, B] }, null, 1))

console.log(`\n===== ${OUT}: 2 DISJOINT slips, odds cap ${ODDS_CAP}x, stake ₦${STAKE}/slip (overlap: ${overlap} games) =====\n`)
for (const [i, s] of [A, B].entries()) {
  console.log(`slip ${i + 1}: ${s.legs.length} legs, combined odds ${s.combinedOdds.toFixed(2)}, trueProb ${(s.trueProb * 100).toFixed(3)}%, payout ₦${s.potentialPayout}`)
  for (const l of s.legs) console.log(`    [${l.market}] ${l.game} — ${l.outcome} @ ${l.odds}`)
}
console.log(`\ntotal stake ₦${STAKE * 2}, total potential payout ₦${A.potentialPayout + B.potentialPayout}`)
console.log(`P(at least one slip wins) ≈ ${((1 - (1 - A.trueProb) * (1 - B.trueProb)) * 100).toFixed(3)}% (independent-ish since games are disjoint)`)

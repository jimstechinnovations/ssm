/**
 * Build one preview ticket containing every SportyBet-listed match from the
 * five requested leagues inside a date window:
 *   Premier League, La Liga, Serie A, Bundesliga, Ligue 1.
 *
 * The script picks one leg per match from the existing multi-market set:
 * U45, O15, DC, DNB, HCP, 1X2. It ranks by a 60/40 blend of bookmaker
 * de-vigged probability and recent-form Poisson probability when history is
 * available. If history is unavailable, it falls back to book probability.
 *
 * No bet is placed. This only writes a JSON ticket preview.
 *
 * Run:
 *   node scripts/build-top5-league-ticket.mjs --stake=1000 --out=top5-ticket.json --toISO=2026-08-31T21:59:59Z
 */
import { writeFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas, formProbFor } from './lib-form-model.mjs'

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const MARKETS = '1,10,11,16,18'
const MIN_ODDS = 1.20
const BOOK_WEIGHT = 0.6
const FORM_WEIGHT = 0.4
const MIN_GAMES_FOR_FORM = 3

const arg = (name, fallback = null) => {
  const found = process.argv.find(x => x.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const STAKE = Number(arg('stake', '1000'))
const OUT = arg('out', 'top5-league-ticket.json')
const FROM = new Date(arg('fromISO', new Date().toISOString())).getTime()
const TO = new Date(arg('toISO', '2026-08-31T21:59:59Z')).getTime()
const NO_HISTORY = process.argv.includes('--noHistory')
const MIN_PROB = arg('minProb') == null ? null : Number(arg('minProb'))
const MAX_PROB = arg('maxProb') == null ? null : Number(arg('maxProb'))
const MAX_LEGS = arg('maxLegs') == null ? null : Number(arg('maxLegs'))
const ONE_PER_LEAGUE = process.argv.includes('--onePerLeague')
const GROUP_SIZE = arg('groupSize') == null ? null : Number(arg('groupSize'))
const ALL_LEAGUES = process.argv.includes('--allLeagues')
const TARGET_MIN_ODDS = arg('targetMinOdds') == null ? null : Number(arg('targetMinOdds'))
const TARGET_MAX_ODDS = arg('targetMaxOdds') == null ? null : Number(arg('targetMaxOdds'))

const TARGET_LEAGUES = [
  { key: 'premier-league', label: 'Premier League', country: /england/i, name: /^premier league$/i },
  { key: 'la-liga', label: 'La Liga', country: /spain/i, name: /^(la\s*liga|laliga|primera division)$/i },
  { key: 'serie-a', label: 'Serie A', country: /italy/i, name: /^serie a$/i },
  { key: 'bundesliga', label: 'Bundesliga', country: /germany/i, name: /^bundesliga$/i },
  { key: 'ligue-1', label: 'Ligue 1', country: /france/i, name: /^ligue 1$/i },
]

function targetLeague(tournament) {
  if (ALL_LEAGUES) return { key: 'all', label: tournament.name || 'Unknown League' }
  const country = tournament.categoryName || tournament.category?.name || ''
  const name = tournament.name || ''
  return TARGET_LEAGUES.find(l => l.country.test(country) && l.name.test(name)) ?? null
}

const isSimulated = (t, ev) =>
  /simulat/i.test(t.category?.name || '') ||
  /\bsrl\b/i.test(ev.homeTeamName || '') ||
  /\bsrl\b/i.test(ev.awayTeamName || '')

const devig = (a, b) => {
  const ia = 1 / a
  const ib = 1 / b
  const s = ia + ib
  return { pA: ia / s, pB: ib / s, margin: s - 1 }
}

const devig3 = (h, d, a) => {
  const ih = 1 / h
  const id = 1 / d
  const ia = 1 / a
  const s = ih + id + ia
  return { pH: ih / s, pD: id / s, pA: ia / s, margin: s - 1 }
}

function marketsById(ev) {
  const out = {}
  for (const m of ev.markets || []) {
    if (m.status !== undefined && m.status !== 0) continue
    ;(out[m.id] ??= []).push(m)
  }
  return out
}

function bestCandidates(ev) {
  const mk = marketsById(ev)
  const candidates = []

  const ou45 = (mk['18'] || []).find(m => m.specifier === 'total=4.5')
  if (ou45) {
    const u = ou45.outcomes.find(o => /^under/i.test(o.desc))
    const o = ou45.outcomes.find(x => /^over/i.test(x.desc))
    if (u && o) {
      const { pA, margin } = devig(+u.odds, +o.odds)
      if (+u.odds >= MIN_ODDS) candidates.push({ market: 'U45', outcome: 'Under 4.5', odds: +u.odds, trueProb: pA, margin })
    }
  }

  const ou15 = (mk['18'] || []).find(m => m.specifier === 'total=1.5')
  if (ou15) {
    const u = ou15.outcomes.find(o => /^under/i.test(o.desc))
    const o = ou15.outcomes.find(x => /^over/i.test(x.desc))
    if (u && o) {
      const { pB, margin } = devig(+u.odds, +o.odds)
      if (+o.odds >= MIN_ODDS) candidates.push({ market: 'O15', outcome: 'Over 1.5', odds: +o.odds, trueProb: pB, margin })
    }
  }

  const dc = (mk['10'] || [])[0]
  if (dc) {
    const opts = (dc.outcomes || []).map(o => ({ desc: o.desc, odds: +o.odds })).filter(o => o.odds > 1)
    if (opts.length === 3) {
      const impliedSum = opts.reduce((s, o) => s + 1 / o.odds, 0)
      const cheapest = [...opts].sort((a, b) => a.odds - b.odds)[0]
      if (cheapest.odds >= MIN_ODDS) {
        candidates.push({
          market: 'DC',
          outcome: cheapest.desc,
          odds: cheapest.odds,
          trueProb: (1 / cheapest.odds) / impliedSum,
          margin: impliedSum - 1,
        })
      }
    }
  }

  const dnb = (mk['11'] || [])[0]
  if (dnb) {
    const home = dnb.outcomes.find(o => /^home/i.test(o.desc))
    const away = dnb.outcomes.find(o => /^away/i.test(o.desc))
    if (home && away) {
      const { pA, pB, margin } = devig(+home.odds, +away.odds)
      const fav = +home.odds <= +away.odds
        ? { desc: 'Home (DNB)', odds: +home.odds, p: pA }
        : { desc: 'Away (DNB)', odds: +away.odds, p: pB }
      if (fav.odds >= MIN_ODDS) candidates.push({ market: 'DNB', outcome: fav.desc, odds: fav.odds, trueProb: fav.p, margin })
    }
  }

  const x12 = (mk['1'] || [])[0]
  if (x12) {
    const home = x12.outcomes.find(o => /^home/i.test(o.desc))
    const draw = x12.outcomes.find(o => /^draw/i.test(o.desc))
    const away = x12.outcomes.find(o => /^away/i.test(o.desc))
    if (home && draw && away) {
      const { pH, pA, margin } = devig3(+home.odds, +draw.odds, +away.odds)
      const fav = pH >= pA
        ? { desc: `Home [${ev.homeTeamName}]`, odds: +home.odds, p: pH }
        : { desc: `Away [${ev.awayTeamName}]`, odds: +away.odds, p: pA }
      if (fav.odds >= MIN_ODDS) candidates.push({ market: '1X2', outcome: fav.desc, odds: fav.odds, trueProb: fav.p, margin })
    }
  }

  const hcpLines = mk['16'] || []
  if (x12 && hcpLines.length) {
    const home = x12.outcomes.find(o => /^home/i.test(o.desc))
    const away = x12.outcomes.find(o => /^away/i.test(o.desc))
    if (home && away) {
      const favIsHome = +home.odds <= +away.odds
      const half = hcpLines.find(m => m.specifier === (favIsHome ? 'hcp=-0.5' : 'hcp=0.5'))
      if (half) {
        const favDesc = favIsHome ? /^home/i : /^away/i
        const favOut = half.outcomes.find(o => favDesc.test(o.desc) && /\(-0\.5\)/.test(o.desc))
        const dogOut = half.outcomes.find(o => !favDesc.test(o.desc))
        if (favOut && dogOut) {
          const { pA, margin } = devig(+favOut.odds, +dogOut.odds)
          if (+favOut.odds >= MIN_ODDS) {
            candidates.push({
              market: 'HCP',
              outcome: `${favOut.desc} [${favIsHome ? ev.homeTeamName : ev.awayTeamName}]`,
              odds: +favOut.odds,
              trueProb: pA,
              margin,
            })
          }
        }
      }
    }
  }

  return candidates.sort((a, b) => b.trueProb - a.trueProb)
}

async function enrich(row) {
  const bookPick = row.candidates[0]
  if (NO_HISTORY) return { ...row, picked: bookPick, formUsed: false }

  const [home, away] = row.game.split(' vs ').map(x => x.trim())
  const pair = home && away ? await fetchTeamResultsPair(home, away) : null
  if (!pair || pair.homeResults.length < MIN_GAMES_FOR_FORM || pair.awayResults.length < MIN_GAMES_FOR_FORM) {
    return { ...row, picked: bookPick, formUsed: false }
  }

  const lambdas = estimateLambdas(pair.homeResults, pair.awayResults, home, away)
  const ranked = row.candidates.map(c => {
    const fp = formProbFor(c.market, lambdas.lambdaHome, lambdas.lambdaAway)
    const formProb = fp == null ? null : typeof fp === 'number'
      ? fp
      : /^home/i.test(c.outcome) ? fp.pHomeWin : fp.pAwayWin
    const blendProb = formProb == null ? c.trueProb : BOOK_WEIGHT * c.trueProb + FORM_WEIGHT * formProb
    return { ...c, formProb, blendProb }
  }).sort((a, b) => b.blendProb - a.blendProb)

  const picked = ranked[0]
  return {
    ...row,
    picked,
    formUsed: true,
    historySource: pair.source,
    lambdas,
    changedByForm: picked.market !== bookPick.market || picked.outcome !== bookPick.outcome,
    bookPick,
  }
}

async function pool(items, worker, concurrency = 4) {
  const results = new Array(items.length)
  let idx = 0
  async function next() {
    while (idx < items.length) {
      const i = idx++
      results[i] = await worker(items[i])
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next))
  return results
}

function dcOutcomeId(desc) {
  if (/home.*draw/i.test(desc)) return '9'
  if (/home.*away/i.test(desc)) return '10'
  if (/draw.*away/i.test(desc)) return '11'
  return null
}

function selectionFor(leg) {
  const eventId = `sr:match:${leg.fixtureId}`
  switch (leg.market) {
    case 'U45': return { eventId, marketId: '18', specifier: 'total=4.5', outcomeId: '13' }
    case 'O15': return { eventId, marketId: '18', specifier: 'total=1.5', outcomeId: '12' }
    case 'DC': return { eventId, marketId: '10', specifier: '', outcomeId: dcOutcomeId(leg.outcome) }
    case 'DNB': return { eventId, marketId: '11', specifier: '', outcomeId: /^home/i.test(leg.outcome) ? '4' : '5' }
    case 'HCP': return {
      eventId,
      marketId: '16',
      specifier: /^home/i.test(leg.outcome) ? 'hcp=-0.5' : 'hcp=0.5',
      outcomeId: /^home/i.test(leg.outcome) ? '1714' : '1715',
    }
    case '1X2': return { eventId, marketId: '1', specifier: '', outcomeId: /^home/i.test(leg.outcome) ? '1' : '3' }
    default: return null
  }
}

console.log(`Window: ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()}`)
console.log(`Target leagues: ${TARGET_LEAGUES.map(l => l.label).join(', ')}`)
if (NO_HISTORY) console.log('History/form lookup: skipped (--noHistory)')

const rows = []
const skipped = []
for (let pg = 1; pg <= 20; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=${MARKETS}&pageSize=100&pageNum=${pg}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break

  let pageEvents = 0
  for (const t of json.data.tournaments) {
    const league = targetLeague(t)
    if (!league) continue
    for (const ev of t.events || []) {
      pageEvents++
      if (isSimulated(t, ev)) continue
      if (ev.estimateStartTime < FROM || ev.estimateStartTime > TO) continue

      const candidates = bestCandidates(ev)
      const row = {
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        league: league.label,
        tournament: t.name,
        kickoff: new Date(ev.estimateStartTime).toISOString(),
      }
      if (candidates.length) rows.push({ ...row, candidates })
      else skipped.push({ ...row, reason: `no qualifying market at min odds ${MIN_ODDS}` })
    }
  }
  if (pageEvents === 0 && pg > 8) break
}

rows.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.league.localeCompare(b.league))
console.log(`Found ${rows.length} selectable matches; skipped ${skipped.length}. ${NO_HISTORY ? 'Using book-only ranking...' : 'Running form check...'}`)

const enriched = await pool(rows, enrich, 4)
await closeHistorySession()

let legs = enriched.map(r => ({
  fixtureId: r.fixtureId,
  game: r.game,
  league: r.league,
  tournament: r.tournament,
  kickoff: r.kickoff,
  market: r.picked.market,
  outcome: r.picked.outcome,
  odds: r.picked.odds,
  trueProb: r.picked.trueProb,
  formProb: r.picked.formProb ?? null,
  blendProb: r.picked.blendProb ?? r.picked.trueProb,
  formUsed: r.formUsed,
  historySource: r.historySource ?? null,
  changedByForm: r.changedByForm ?? false,
  bookPick: r.bookPick ? { market: r.bookPick.market, outcome: r.bookPick.outcome, odds: r.bookPick.odds, trueProb: r.bookPick.trueProb } : null,
})).filter(l =>
  (MIN_PROB == null || l.blendProb >= MIN_PROB) &&
  (MAX_PROB == null || l.blendProb <= MAX_PROB)
).sort((a, b) => b.blendProb - a.blendProb || a.kickoff.localeCompare(b.kickoff))

if (ONE_PER_LEAGUE) {
  const byLeague = new Map()
  for (const leg of legs) if (!byLeague.has(leg.league)) byLeague.set(leg.league, leg)
  legs = TARGET_LEAGUES.map(l => byLeague.get(l.label)).filter(Boolean)
}

if (TARGET_MIN_ODDS != null || TARGET_MAX_ODDS != null) {
  const minTarget = TARGET_MIN_ODDS ?? 1
  const maxTarget = TARGET_MAX_ODDS ?? Infinity
  const picked = []
  let prod = 1
  for (const leg of legs) {
    const next = prod * leg.odds
    if (next > maxTarget && picked.length > 0) continue
    picked.push(leg)
    prod = next
    if (prod >= minTarget) break
  }
  if (prod < minTarget) {
    for (const leg of legs) {
      if (picked.some(p => p.fixtureId === leg.fixtureId)) continue
      picked.push(leg)
      prod *= leg.odds
      if (prod >= minTarget) break
    }
  }
  legs = picked
}

if (MAX_LEGS != null) legs.length = Math.min(legs.length, MAX_LEGS)

function summarizeSlip(slipLegs) {
  const combinedOdds = slipLegs.reduce((p, l) => p * l.odds, 1)
  const combinedBookProb = slipLegs.reduce((p, l) => p * l.trueProb, 1)
  const combinedBlendProb = slipLegs.reduce((p, l) => p * l.blendProb, 1)
  return {
    legs: slipLegs,
    selections: slipLegs.map(selectionFor).filter(Boolean),
    combinedOdds,
    combinedBookProb,
    combinedBlendProb,
    potentialPayout: Math.round(combinedOdds * STAKE),
  }
}

function groupRealisticSlipBook(allLegs, size) {
  const groups = []
  const ordered = [...allLegs].sort((a, b) => a.kickoff.localeCompare(b.kickoff))
  for (let i = 0; i < ordered.length; i += size) groups.push(summarizeSlip(ordered.slice(i, i + size)))
  return groups
}

const slips = GROUP_SIZE ? groupRealisticSlipBook(legs, GROUP_SIZE) : null
const primarySlip = slips ? summarizeSlip(legs) : summarizeSlip(legs)

const ticket = {
  generatedAt: new Date().toISOString(),
  window: { fromISO: new Date(FROM).toISOString(), toISO: new Date(TO).toISOString() },
  requestedLeagues: ALL_LEAGUES ? ['All real football leagues'] : TARGET_LEAGUES.map(l => l.label),
  stake: STAKE,
  minOdds: MIN_ODDS,
  probabilityFilter: {
    minProb: MIN_PROB,
    maxProb: MAX_PROB,
    maxLegs: MAX_LEGS,
    onePerLeague: ONE_PER_LEAGUE,
    groupSize: GROUP_SIZE,
    allLeagues: ALL_LEAGUES,
    targetMinOdds: TARGET_MIN_ODDS,
    targetMaxOdds: TARGET_MAX_ODDS,
  },
  note: 'Preview only. No stake entered and no bet placed.',
  slip: primarySlip,
  slips,
  skipped,
}

writeFileSync(OUT, JSON.stringify(ticket, null, 2))

console.log(`\nWrote ${OUT}`)
console.log(`Legs: ${legs.length}`)
if (slips) {
  console.log(`Slip groups: ${slips.length} x up to ${GROUP_SIZE} legs`)
  for (const [i, s] of slips.entries()) {
    console.log(`  slip ${i + 1}: ${s.legs.length} legs, odds ${s.combinedOdds.toFixed(2)}, book probability ${(s.combinedBookProb * 100).toFixed(3)}%, payout ${s.potentialPayout}`)
  }
} else {
  console.log(`Combined odds: ${primarySlip.combinedOdds.toFixed(2)}`)
  console.log(`Book probability product: ${(primarySlip.combinedBookProb * 100).toFixed(6)}%`)
  console.log(`Blend probability product: ${(primarySlip.combinedBlendProb * 100).toFixed(6)}%`)
  console.log(`Potential payout at stake ${STAKE}: ${ticket.slip.potentialPayout}`)
}
console.log('\nSelections:')
for (const l of legs) {
  const source = l.formUsed ? `blend ${(l.blendProb * 100).toFixed(1)}%` : `book ${(l.trueProb * 100).toFixed(1)}%`
  console.log(`[${l.league}] ${l.kickoff} ${l.game} -> [${l.market}] ${l.outcome} @ ${l.odds} (${source})`)
}
if (skipped.length) {
  console.log('\nSkipped matches:')
  for (const s of skipped) console.log(`[${s.league}] ${s.kickoff} ${s.game} - ${s.reason}`)
}

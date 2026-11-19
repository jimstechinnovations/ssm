/**
 * scripts/build-multimarket-pedla-book.mjs — NEW PATH, does not touch the existing U4.5 chain
 * (app/api/pedlas/route.ts, lib/pedlas/build-book.ts, scripts/build-pedla-book.mjs are all untouched).
 *
 * Engine-run variant on top of the multi-market "best-of-5" base (scripts/build-test-multimarket-slip.mjs):
 *
 *   1. BASE: per fixture, pick the single best candidate leg across U45/O15/DC/DNB/HCP (same picker
 *      as the test script). Sort by true probability (most reliable first), greedily add fixtures
 *      until the NEXT one would push the all-hit combined odds over oddsCap — auto-fits the base pool
 *      to the cap instead of a fixed leg count.
 *   2. VARIANT SLIPS: slip #1 is the base (every leg = its best pick). Each further slip covers "a
 *      different result" by taking the SINGLE weakest leg (closest runner-up, i.e. least confident
 *      pick) and swapping it to that fixture's next-best market, OR dropping it if no swap fits under
 *      oddsCap — same best-first logic as build-pedla-book.mjs's flip-vector expansion, generalised
 *      from "Under->Over on one axis" to "picked market -> runner-up market, or drop".
 *
 * Every slip's combined odds stays <= oddsCap. Still -vig, still no edge — this only reshapes
 * structure, matching the honesty stance in pedla_v1.md / docs/algorithm.md.
 *
 * Run: node scripts/build-multimarket-pedla-book.mjs [oddsCap=100] [slips=2] [stake=1000] [out=multimarket-book.json]
 */
import { writeFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas, formProbFor } from './lib-form-model.mjs'

const BOOK_WEIGHT = 0.6, FORM_WEIGHT = 0.4
const MIN_GAMES_FOR_FORM = 3

const ODDS_CAP = Number(process.argv[2] || 100)
const K = Number(process.argv[3] || 2)
const STAKE = Number(process.argv[4] || 1000)
const OUT = process.argv[5] || 'multimarket-book.json'
// optional explicit UTC window override, e.g. --minKickISO=2026-08-16T23:00:00Z --maxKickISO=2026-08-17T04:00:00Z
const isoArg = (name) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? new Date(a.split('=')[1]).getTime() : null }
const MIN_KICK_OVERRIDE = isoArg('minKickISO')
const MAX_KICK_OVERRIDE = isoArg('maxKickISO')

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const MARKETS = '1,10,11,15,16,18,19,20,25,29'
// MIN_ODDS gates which candidates even qualify. 1.20 is the Win-Boost-eligibility floor, but it also
// caps out true probability around ~83% (odds and probability move opposite ways) — so it silently
// EXCLUDES the safest legs (85%+, odds <1.20) by default. Override with --minOdds= to let those in
// when the ask is specifically for very reliable (80-85%+) picks, at the cost of Win Boost eligibility
// on the legs below 1.20.
const minOddsArg = process.argv.find(x => x.startsWith('--minOdds='))
const MIN_ODDS = minOddsArg ? Number(minOddsArg.split('=')[1]) : 1.20
// --exclude=OU2.5:Over,OU3.5:Over blocks specific market+outcome-prefix combos from ever being picked
// (the candidate is dropped entirely, so bestLeg() falls through to the next-best market for that game).
const excludeArg = process.argv.find(x => x.startsWith('--exclude='))
const EXCLUDES = excludeArg ? excludeArg.slice('--exclude='.length).split(',').map(s => { const [market, prefix] = s.split(':'); return { market, prefix } }) : []
// market pattern ending in '*' matches by prefix (e.g. "OU*" covers OU2.5, OU3.5, ... all in one go —
// the O/U line markets are dynamically named per line, so listing every line out isn't practical).
const isExcluded = (market, outcome) => EXCLUDES.some(e => {
  const marketMatches = e.market.endsWith('*') ? market.startsWith(e.market.slice(0, -1)) : market === e.market
  return marketMatches && new RegExp(`^${e.prefix}`, 'i').test(outcome)
})

const devig = (a, b) => { const ia = 1 / a, ib = 1 / b, s = ia + ib; return { pA: ia / s, pB: ib / s, margin: s - 1 } }
/** 3-way de-vig for 1X2 (Home/Draw/Away) — draws are a real loss here, unlike DNB which voids them. */
const devig3 = (h, d, a) => { const ih = 1 / h, id = 1 / d, ia = 1 / a, s = ih + id + ia; return { pH: ih / s, pD: id / s, pA: ia / s, margin: s - 1 } }
// status !== 0 means suspended/deactivated — same filter the real adapter uses (lib/books/sportybet.ts)
function marketsById(ev) { const out = {}; for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (out[m.id] ??= []).push(m) }; return out }

/** Same 5-market picker as scripts/build-test-multimarket-slip.mjs — kept in sync deliberately. */
function bestLeg(ev) {
  const mk = marketsById(ev)
  const candidates = []

  // Scan EVERY posted Over/Under line (0.5, 1.5, 2.5, 3.5, 4.5, 5.5, ...), not just fixed 1.5/4.5 —
  // "every market in the book": whichever side of whichever line is genuinely most probable for this
  // fixture gets its own candidate slot, instead of being limited to two hand-picked lines.
  const ouLines = (mk['18'] || []).filter(m => /^total=/.test(m.specifier || ''))
  for (const line of ouLines) {
    const u = line.outcomes.find(o => /^under/i.test(o.desc)), o = line.outcomes.find(x => /^over/i.test(x.desc))
    if (!u || !o) continue
    const { pA, pB, margin } = devig(+u.odds, +o.odds)
    const lineNum = line.specifier.split('=')[1]
    const pick = pA >= pB ? { desc: `Under ${lineNum}`, odds: +u.odds, p: pA } : { desc: `Over ${lineNum}`, odds: +o.odds, p: pB }
    if (pick.odds >= MIN_ODDS) candidates.push({ market: `OU${lineNum}`, outcome: pick.desc, odds: pick.odds, trueProb: pick.p, margin })
  }
  // Home/Away team-goals O/U (market 19/20) — same multi-line scan, marginal to one team's own goals.
  for (const [mid, prefix] of [['19', 'HOU'], ['20', 'AOU']]) {
    const lines = (mk[mid] || []).filter(m => /^total=/.test(m.specifier || ''))
    for (const line of lines) {
      const u = line.outcomes.find(o => /^under/i.test(o.desc)), o = line.outcomes.find(x => /^over/i.test(x.desc))
      if (!u || !o) continue
      const { pA, pB, margin } = devig(+u.odds, +o.odds)
      const lineNum = line.specifier.split('=')[1]
      const pick = pA >= pB ? { desc: `Under ${lineNum}`, odds: +u.odds, p: pA } : { desc: `Over ${lineNum}`, odds: +o.odds, p: pB }
      if (pick.odds >= MIN_ODDS) candidates.push({ market: `${prefix}${lineNum}`, outcome: pick.desc, odds: pick.odds, trueProb: pick.p, margin })
    }
  }
  // Winning Margin, restricted to "win by exactly 1" (market 15) — this is ONE 7-way market
  // (by1/by2/by3+ x home/away, plus Draw), so "Home by 1" and "Away by 1" must be devigged against
  // the FULL outcome set (like DC/Goal Range's N-way devig), NOT against each other pairwise —
  // a pairwise devig would silently treat two long-shot outcomes as the market's only two outcomes
  // and wildly inflate whichever is shorter-priced.
  const margin1 = (mk['15'] || [])[0]
  if (margin1) {
    const allOpts = (margin1.outcomes || []).filter(o => +o.odds > 1)
    const impliedSum = allOpts.reduce((s, o) => s + 1 / +o.odds, 0)
    const homeBy1 = margin1.outcomes.find(o => /^home by 1$/i.test(o.desc)), awayBy1 = margin1.outcomes.find(o => /^away by 1$/i.test(o.desc))
    if (homeBy1 && awayBy1 && impliedSum > 0) {
      const pHome = (1 / +homeBy1.odds) / impliedSum, pAway = (1 / +awayBy1.odds) / impliedSum
      const pick = pHome >= pAway
        ? { desc: `Home by 1 [${ev.homeTeamName}]`, odds: +homeBy1.odds, p: pHome, id: homeBy1.id }
        : { desc: `Away by 1 [${ev.awayTeamName}]`, odds: +awayBy1.odds, p: pAway, id: awayBy1.id }
      if (pick.odds >= MIN_ODDS) {
        candidates.push({
          market: 'MARGIN1', outcome: pick.desc, odds: pick.odds, trueProb: pick.p, margin: impliedSum - 1,
          rawMarketId: '15', rawSpecifier: margin1.specifier, rawOutcomeId: pick.id,
        })
      }
    }
  }
  // Both Teams To Score (GG/NG, market 29).
  const btts = (mk['29'] || [])[0]
  if (btts) {
    const yes = btts.outcomes.find(o => /^yes/i.test(o.desc)), no = btts.outcomes.find(o => /^no/i.test(o.desc))
    if (yes && no) {
      const { pA, pB, margin } = devig(+yes.odds, +no.odds)
      const pick = pA >= pB ? { desc: 'Yes', odds: +yes.odds, p: pA } : { desc: 'No', odds: +no.odds, p: pB }
      if (pick.odds >= MIN_ODDS) candidates.push({ market: 'BTTS', outcome: pick.desc, odds: pick.odds, trueProb: pick.p, margin })
    }
  }
  // Goal Range ("goal bounds", market 25) — discrete buckets like 0-1/2-3/4-6/7+, N-way devig.
  // Outcome ids here are per-event opaque strings (e.g. "sr:goal_range:7+:1342"), not fixed constants
  // like O/U's 12/13 — so the raw marketId/specifier/outcomeId are stashed on the candidate and
  // carried straight through to the booking-code step instead of being re-derived from the outcome text.
  const goalRange = (mk['25'] || [])[0]
  if (goalRange) {
    const opts = (goalRange.outcomes || []).map(o => ({ id: o.id, desc: o.desc, odds: +o.odds })).filter(o => o.odds > 1)
    if (opts.length >= 2) {
      const impliedSum = opts.reduce((s, o) => s + 1 / o.odds, 0)
      const cheapest = [...opts].sort((a, b) => a.odds - b.odds)[0]
      const p = (1 / cheapest.odds) / impliedSum
      if (cheapest.odds >= MIN_ODDS) {
        candidates.push({
          market: 'GOALRANGE', outcome: `Goals ${cheapest.desc}`, odds: cheapest.odds, trueProb: p, margin: impliedSum - 1,
          rawMarketId: '25', rawSpecifier: goalRange.specifier, rawOutcomeId: cheapest.id,
        })
      }
    }
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
      const { pH, pD, pA, margin } = devig3(+home.odds, +draw.odds, +away.odds)
      // straight win only — Draw itself isn't a useful "prediction" leg to bet on here, only Home/Away
      const fav = pH >= pA ? { desc: `Home [${ev.homeTeamName}]`, odds: +home.odds, p: pH } : { desc: `Away [${ev.awayTeamName}]`, odds: +away.odds, p: pA }
      if (fav.odds >= MIN_ODDS) candidates.push({ market: '1X2', outcome: fav.desc, odds: fav.odds, trueProb: fav.p, margin })
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

  const filtered = EXCLUDES.length ? candidates.filter(c => !isExcluded(c.market, c.outcome)) : candidates
  if (!filtered.length) return null
  filtered.sort((a, b) => b.trueProb - a.trueProb)
  return filtered
}

/**
 * Blend each candidate's book trueProb with a form-implied probability (recency-weighted Poisson
 * model from each team's own last-N results, lib-form-model.mjs), then re-rank by the blend. This
 * is what actually lets history CHANGE the pick, not just annotate it — requested explicitly after
 * the disjoint-slip run never even queried history. Falls back to pure book ranking when neither
 * team has enough recent games (MIN_GAMES_FOR_FORM), same honest-degradation the engine uses
 * elsewhere (lib/pedlas/enrich.ts's requireHistory gate).
 */
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
    const fp = formProbFor(c.market, lambdas.lambdaHome, lambdas.lambdaAway, c.outcome)
    const formProb = fp == null ? null : (typeof fp === 'number' ? fp : (/^home/i.test(c.outcome) ? fp.pHomeWin : fp.pAwayWin))
    const blendProb = formProb == null ? c.trueProb : BOOK_WEIGHT * c.trueProb + FORM_WEIGHT * formProb
    return { ...c, formProb, blendProb }
  }).sort((a, b) => b.blendProb - a.blendProb)

  const picked = blended[0], runnerUp = blended[1] ?? null, bookPick = bookRanked[0]
  const changed = picked.market !== bookPick.market || picked.outcome !== bookPick.outcome
  return { ...row, picked, runnerUp, formUsed: true, historySource: pair.source, lambdas, changed, bookPick }
}

/** Small concurrency-limited pool — apifootball can go a few at once, SofaScore shares one page anyway. */
async function pool(items, worker, concurrency = 4) {
  const results = new Array(items.length)
  let idx = 0
  async function next() { while (idx < items.length) { const i = idx++; results[i] = await worker(items[i]) } }
  await Promise.all(Array.from({ length: concurrency }, next))
  return results
}

// Country/category lives on the EVENT (ev.sport.category.name), not the tournament grouping object —
// the top-level tournament object has no .category at all. Every league-restricting filter must read
// it from here.
const countryOf = (ev) => ev.sport?.category?.name || ''

// Simulated Reality League (category "Simulated Reality League", team names suffixed "SRL"/"Srl") is
// computer-generated fake football using real club names — NOT real matches. Always excluded, no flag.
const isSimulated = (ev) => /simulat/i.test(countryOf(ev)) || /\bsrl\b/i.test(ev.homeTeamName) || /\bsrl\b/i.test(ev.awayTeamName)

// --famousOnly restricts to recognised top-tier leagues/competitions (real clubs, better data coverage).
const FAMOUS_LEAGUES = [
  'premier league', 'laliga', 'la liga', 'serie a', 'bundesliga', 'ligue 1', 'eredivisie',
  'primeira liga', 'championship', 'süper lig', 'super lig', 'scottish premiership',
  'champions league', 'europa league', 'conference league', 'copa libertadores', 'copa sudamericana',
  'mls', 'liga mx', 'brasileirao', 'brasileiro', 'primera division', 'copa del rey', 'coppa italia',
  'dfb-pokal', 'fa cup', 'league cup', 'community shield', 'world cup', 'euro', 'nations league',
]
const FAMOUS_ONLY = process.argv.includes('--famousOnly')
const isFamous = (t) => FAMOUS_LEAGUES.some(l => (t.name || '').toLowerCase().includes(l))

// --top5Only: EXACTLY the big-5 European top flights, matched on country + EXACT league name.
// Must be exact equality, not substring — "bundesliga" as a substring also matches "2. Bundesliga",
// and "laliga" also matches "LALIGA HYPERMOTION" (Spain's SECOND division), which would silently
// pull in lower-tier fixtures despite this filter's entire point being top-flight-only.
const TOP5 = [
  { country: 'england', league: 'premier league' },
  { country: 'spain', league: 'laliga' },
  { country: 'spain', league: 'la liga' },
  { country: 'italy', league: 'serie a' },
  { country: 'germany', league: 'bundesliga' },
  { country: 'france', league: 'ligue 1' },
]
const TOP5_ONLY = process.argv.includes('--top5Only')
const isTop5 = (t, ev) => {
  const country = countryOf(ev).toLowerCase(), name = (t.name || '').toLowerCase()
  return TOP5.some(x => country === x.country && name === x.league)
}

// --topTeamsOnly: only fixtures featuring one of a fixed list of elite clubs. Each entry is a regex
// matched against the RAW team name (not lowercased first — some patterns rely on exact casing like
// "AC Milan"), deliberately narrow to dodge same-word lower-league/other-continent namesakes (e.g.
// "Inter Miami", "Sporting Kansas City", "Barcelona SC" Ecuador, "Ajax Cape Town", women's sides
// suffixed " W" / "Women").
const TOP_TEAMS = [
  /\breal madrid\b/i, /\bbayern (munich|münchen|muenchen)\b/i, /\bparis saint-germain\b|\bpsg\b/i,
  /^liverpool$/i, /\bmanchester city\b|\bman city\b/i, /^inter$|\binter milan\b/i,
  /^barcelona$/i, /^arsenal$/i, /^chelsea$/i, /\batl[eé]tico madrid\b/i, /\bborussia dortmund\b/i,
  /^juventus$/i, /\bnapoli\b/i, /\bbayer leverkusen\b/i, /\bmanchester united\b|\bman utd\b/i,
  /^ac milan$/i, /\bnewcastle united\b|^newcastle$/i, /\btottenham\b/i, /\bbenfica\b/i,
  /\bsporting cp\b|\bsporting lisbon\b/i, /\batalanta\b/i, /\brb leipzig\b|\brasenballsport leipzig\b/i,
  /\bathletic bilbao\b/i, /\bgalatasaray\b/i, /^ajax$|\bajax amsterdam\b/i,
]
const TOP_TEAMS_ONLY = process.argv.includes('--topTeamsOnly')
const isWomens = (name) => /\bwomen\b|\bw$/i.test((name || '').trim())
// Reserve/youth sides (Jong Ajax, Benfica B, Inter Milano U23, ...) aren't the first team the
// ranking actually refers to — exclude them even though the parent club name still matches above.
const isReserveOrYouth = (name) => /\bjong\b|\bu-?(1[7-9]|2[0-3])\b|\bii\b|\breserves?\b|\byouth\b|\bb$/i.test((name || '').trim())
const isTopTeam = (ev) => {
  const h = ev.homeTeamName, a = ev.awayTeamName
  if (isWomens(h) || isWomens(a)) return false
  if (isReserveOrYouth(h) || isReserveOrYouth(a)) return false
  return TOP_TEAMS.some(re => re.test(h) || re.test(a))
}

// ── fetch upcoming fixtures (next 24h, >=3h out) and pick a candidate per fixture ──
const minKick = MIN_KICK_OVERRIDE ?? (Date.now() + 3 * 3600 * 1000)
const maxKick = MAX_KICK_OVERRIDE ?? (Date.now() + 24 * 3600 * 1000)
console.log(`kickoff window: ${new Date(minKick).toISOString()} .. ${new Date(maxKick).toISOString()}`)
if (FAMOUS_ONLY) console.log('--famousOnly: restricting to recognised top-tier leagues/competitions')
if (TOP5_ONLY) console.log('--top5Only: restricting to Premier League, LaLiga, Serie A, Bundesliga, Ligue 1 (country-matched)')
if (TOP_TEAMS_ONLY) console.log('--topTeamsOnly: restricting to a fixed list of elite clubs')
const rows = []
for (let pg = 1; pg <= 20; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=${MARKETS}&pageSize=100&pageNum=${pg}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) {
    if (FAMOUS_ONLY && !isFamous(t)) continue
    for (const ev of t.events || []) {
      pageEvents++
      if (TOP5_ONLY && !isTop5(t, ev)) continue
      if (TOP_TEAMS_ONLY && !isTopTeam(ev)) continue
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

console.log(`\nrunning form-model check for ${rows.length} fixtures (apifootball + SofaScore fallback, not just close calls)...`)
const enriched = await pool(rows, enrichRow, 4)
rows.length = 0; rows.push(...enriched)
await closeHistorySession()
const formCount = rows.filter(r => r.formUsed).length
const changedCount = rows.filter(r => r.changed).length
console.log(`form data available for ${formCount}/${rows.length} fixtures; form model CHANGED the pick vs book-only on ${changedCount} of those\n`)

// most reliable first — blended probability when form was available, book trueProb otherwise
rows.sort((a, b) => (b.picked.blendProb ?? b.picked.trueProb) - (a.picked.blendProb ?? a.picked.trueProb))

// optional reliability floor — drop legs below this true-probability instead of reaching for weak
// picks just to fill the leg count, e.g. --minTrueProb=0.70
const minTrueProbArg = process.argv.find(x => x.startsWith('--minTrueProb='))
if (minTrueProbArg) {
  const floor = Number(minTrueProbArg.split('=')[1])
  const before = rows.length
  const filtered = rows.filter(r => r.picked.trueProb >= floor)
  console.log(`--minTrueProb=${floor}: ${before} -> ${filtered.length} legs (dropped ${before - filtered.length} weak picks)`)
  rows.length = 0; rows.push(...filtered)
}

// ── auto-fit base pool: stop at oddsCap OR maxLegs, whichever comes first. maxLegs is the lever
// that actually controls per-slip win probability — a 100x-odds cap always maximises leg count
// (near-zero win chance); capping legs directly (e.g. --maxLegs=8) keeps the slip short enough to
// have a real shot, at the cost of a smaller payout. ──
// SportyBet hard-caps a betslip at 50 selections — exceeding it silently truncates at placement
// (confirmed live: a 51-leg slip got cut to 50 and placed at whatever stake was left, not what was
// intended). Always enforce this ceiling even if --maxLegs asks for more.
const SITE_MAX_LEGS = 50
const maxLegsArg = process.argv.find(x => x.startsWith('--maxLegs='))
const MAX_LEGS = Math.min(maxLegsArg ? Number(maxLegsArg.split('=')[1]) : Infinity, SITE_MAX_LEGS)
const base = []
let prod = 1
for (const r of rows) {
  if (base.length >= MAX_LEGS) break
  const next = prod * r.picked.odds
  if (base.length > 0 && next > ODDS_CAP) break // stop BEFORE exceeding the cap
  base.push(r)
  prod = next
  if (next > ODDS_CAP) break // single-leg overshoot (shouldn't happen at MIN_ODDS=1.20) — take it and stop
}
if (base.length === 0) {
  console.error('No qualifying fixtures found in window.')
  process.exit(1)
}

// ── analysis print: every leg now carries a book-vs-form-blended decision. "CHANGED" means the
// form model actually picked a DIFFERENT market than pure book odds would have — that's the real
// signal this isn't going in blind anymore. Still not claimed edge (pedla_v2.md §1a) — form is a
// second honest estimate blended 60/40 with the book, not a beat-the-book model. ──
console.log(`===== ANALYSIS: ${base.length} base legs =====\n`)
for (const r of base) {
  const p = r.picked
  const tag = !r.formUsed ? '(book-only, insufficient history)' : r.changed ? `** CHANGED by form ** (book favoured [${r.bookPick.market}] ${r.bookPick.outcome} @ ${(r.bookPick.trueProb * 100).toFixed(1)}%)` : '(form agrees with book)'
  console.log(`[${p.market}] ${r.game} — ${p.outcome} @ ${p.odds}  book=${(p.trueProb * 100).toFixed(1)}%${r.formUsed ? ` form=${(p.formProb * 100).toFixed(1)}% blend=${(p.blendProb * 100).toFixed(1)}% [${r.historySource}]` : ''} ${tag}`)
}

function slipFromBase(legs) {
  const combinedOdds = legs.reduce((p, l) => p * l.odds, 1)
  const trueProb = legs.reduce((p, l) => p * l.trueProb, 1)
  return {
    stake: STAKE,
    legs: legs.map(l => ({ fixtureId: l.fixtureId, game: l.game, league: l.league, kickoff: l.kickoff, market: l.market, outcome: l.outcome, odds: l.odds, ...(l.rawMarketId ? { rawMarketId: l.rawMarketId, rawSpecifier: l.rawSpecifier, rawOutcomeId: l.rawOutcomeId } : {}) })),
    combinedOdds, trueProb, potentialPayout: Math.round(combinedOdds * STAKE),
  }
}

const baseLegs = base.map(r => ({ ...r.picked, fixtureId: r.fixtureId, game: r.game, league: r.league, kickoff: r.kickoff }))
const slips = [slipFromBase(baseLegs)]

// ── variant slips: swap or drop the weakest leg, whichever keeps combinedOdds <= cap, highest resulting trueProb wins ──
const used = new Set() // fixtureIds already varied, so slip #2, #3, ... each vary a DIFFERENT leg
while (slips.length < K) {
  let bestVariant = null
  for (let i = 0; i < base.length; i++) {
    const r = base[i]
    if (used.has(r.fixtureId)) continue

    // option A: swap this leg to its runner-up market
    if (r.runnerUp) {
      const legs = baseLegs.map((l, j) => j === i ? { ...r.runnerUp, fixtureId: r.fixtureId, game: r.game, league: r.league, kickoff: r.kickoff } : l)
      const combinedOdds = legs.reduce((p, l) => p * l.odds, 1)
      if (combinedOdds <= ODDS_CAP) {
        const trueProb = legs.reduce((p, l) => p * l.trueProb, 1)
        if (!bestVariant || trueProb > bestVariant.trueProb) bestVariant = { kind: 'swap', fixtureId: r.fixtureId, legs, trueProb }
      }
    }
    // option B: drop this leg entirely
    const droppedLegs = baseLegs.filter((_, j) => j !== i)
    if (droppedLegs.length > 0) {
      const combinedOdds = droppedLegs.reduce((p, l) => p * l.odds, 1)
      if (combinedOdds <= ODDS_CAP) {
        const trueProb = droppedLegs.reduce((p, l) => p * l.trueProb, 1)
        if (!bestVariant || trueProb > bestVariant.trueProb) bestVariant = { kind: 'drop', fixtureId: r.fixtureId, legs: droppedLegs, trueProb }
      }
    }
  }
  if (!bestVariant) break // no more distinct variants fit under the cap
  used.add(bestVariant.fixtureId)
  slips.push(slipFromBase(bestVariant.legs))
  console.log(`slip #${slips.length}: ${bestVariant.kind === 'swap' ? 'swapped' : 'dropped'} leg for fixture ${bestVariant.fixtureId}`)
}

writeFileSync(OUT, JSON.stringify({ oddsCap: ODDS_CAP, stake: STAKE, slips }, null, 1))

console.log(`\n===== ${OUT}: ${slips.length}/${K} slips, base pool ${base.length} legs, odds cap ${ODDS_CAP}x, stake ₦${STAKE}/slip =====\n`)
for (const [i, s] of slips.entries()) {
  console.log(`slip ${i + 1}: ${s.legs.length} legs, combined odds ${s.combinedOdds.toFixed(2)}, trueProb ${(s.trueProb * 100).toFixed(2)}%, payout ₦${s.potentialPayout}`)
  for (const l of s.legs) console.log(`    [${l.market}] ${l.game} — ${l.outcome} @ ${l.odds}`)
}
console.log(`\ntotal stake ₦${STAKE * slips.length}, total potential payout ₦${slips.reduce((s, x) => s + x.potentialPayout, 0)}`)

/**
 * scripts/cook-history-blend-slip.mjs — like cook-multimarket-pedla-book.mjs (scans every known
 * market per fixture) but ALSO pulls real match history (lib-history.mjs: last-N results + H2H,
 * apifootball with SofaScore/CDP fallback) and blends it with the book odds via a Poisson goal
 * model (lib-form-model.mjs), 60% book / 40% form — same blend build-top5-league-ticket.mjs uses.
 * Falls back to book-only when history isn't available for a team. Takes an explicit fixtureId
 * list (built elsewhere by naming teams) rather than searching, since the point here is "these
 * specific named games", not a market-wide scan.
 *
 * Usage:
 *   node scripts/cook-history-blend-slip.mjs fixtures.json out.json
 *   fixtures.json: [{ fixtureId, game, league, kickoff }, ...]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas, formProbFor } from './lib-form-model.mjs'

const [, , inFile, outFile] = process.argv
if (!inFile) { console.error('usage: node scripts/cook-history-blend-slip.mjs fixtures.json [out.json]'); process.exit(1) }
const OUT = outFile || 'slip-history-blend.json'
const fixtures = JSON.parse(readFileSync(inFile, 'utf8'))

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MIN_ODDS = 1.20
const BOOK_WEIGHT = 0.6, FORM_WEIGHT = 0.4
const MIN_GAMES_FOR_FORM = 3
const MARKET_IDS = '1,10,11,16,18,19,20,29,60110'

// ── fetch raw event data for every requested fixtureId (paginate until all found or data ends) ──
const wanted = new Set(fixtures.map(f => f.fixtureId))
const rawById = {}
for (let pg = 1; pg <= 30; pg++) {
  if (Object.keys(rawById).length >= wanted.size) break
  const res = await fetch(`${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=${MARKET_IDS}&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  for (const t of json.data.tournaments) for (const ev of t.events || []) {
    const fid = Number(String(ev.eventId).split(':').pop())
    if (wanted.has(fid) && !rawById[fid]) rawById[fid] = ev
  }
}
console.log(`Found raw data for ${Object.keys(rawById).length}/${fixtures.length} fixtures`)

// ── per-fixture book candidates across every known market ──
function bookCandidates(ev) {
  const mk = {}
  for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (mk[m.id] ??= []).push(m) }
  const candidates = []
  const o15 = (mk['18'] || []).find(m => m.specifier === 'total=1.5')
  if (o15) { const o = o15.outcomes.find(x => /^over/i.test(x.desc)); if (o?.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ market: 'O15', outcome: 'Over 1.5', odds: +o.odds, trueProb: +o.probability, rawMarketId: '18', rawSpecifier: 'total=1.5', rawOutcomeId: '12' }) }
  const u45 = (mk['18'] || []).find(m => m.specifier === 'total=4.5')
  if (u45) { const u = u45.outcomes.find(x => /^under/i.test(x.desc)); if (u?.isActive === 1 && +u.odds >= MIN_ODDS) candidates.push({ market: 'U45', outcome: 'Under 4.5', odds: +u.odds, trueProb: +u.probability, rawMarketId: '18', rawSpecifier: 'total=4.5', rawOutcomeId: '13' }) }
  const dc = (mk['10'] || [])[0]
  if (dc) { const opts = (dc.outcomes || []).filter(o => o.isActive === 1 && +o.odds >= MIN_ODDS); if (opts.length) { const c = [...opts].sort((a, b) => +a.odds - +b.odds)[0]; candidates.push({ market: 'DC', outcome: c.desc, odds: +c.odds, trueProb: +c.probability, rawMarketId: '10', rawSpecifier: '', rawOutcomeId: c.id }) } }
  const dnb = (mk['11'] || [])[0]
  if (dnb) { const home = dnb.outcomes.find(o => /^home/i.test(o.desc)), away = dnb.outcomes.find(o => /^away/i.test(o.desc)); if (home?.isActive === 1 && away?.isActive === 1 && (+home.odds >= MIN_ODDS || +away.odds >= MIN_ODDS)) { const fav = +home.odds <= +away.odds ? { o: home, id: '4', side: 'home' } : { o: away, id: '5', side: 'away' }; if (+fav.o.odds >= MIN_ODDS) candidates.push({ market: 'DNB', outcome: `${fav.side === 'home' ? 'Home' : 'Away'} (DNB) [${fav.side === 'home' ? ev.homeTeamName : ev.awayTeamName}]`, odds: +fav.o.odds, trueProb: +fav.o.probability, rawMarketId: '11', rawSpecifier: '', rawOutcomeId: fav.id }) } }
  const hcpHalf = (mk['16'] || []).find(m => m.specifier === 'hcp=-0.5' || m.specifier === 'hcp=0.5')
  if (hcpHalf) { const home = hcpHalf.outcomes.find(o => /^home/i.test(o.desc)), away = hcpHalf.outcomes.find(o => /^away/i.test(o.desc)); for (const [o, side] of [[home, ev.homeTeamName], [away, ev.awayTeamName]]) { if (o?.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ market: 'HCP', outcome: `${o.desc} [${side}]`, odds: +o.odds, trueProb: +o.probability, rawMarketId: '16', rawSpecifier: hcpHalf.specifier, rawOutcomeId: o.id }) } }
  const h19 = (mk['19'] || []).find(m => m.specifier === 'total=0.5')
  if (h19) { const o = h19.outcomes.find(x => /^over/i.test(x.desc)); if (o?.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ market: 'HOU05', outcome: `${ev.homeTeamName} Over 0.5`, odds: +o.odds, trueProb: +o.probability, rawMarketId: '19', rawSpecifier: 'total=0.5', rawOutcomeId: '12' }) }
  const a20 = (mk['20'] || []).find(m => m.specifier === 'total=0.5')
  if (a20) { const o = a20.outcomes.find(x => /^over/i.test(x.desc)); if (o?.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ market: 'AOU05', outcome: `${ev.awayTeamName} Over 0.5`, odds: +o.odds, trueProb: +o.probability, rawMarketId: '20', rawSpecifier: 'total=0.5', rawOutcomeId: '12' }) }
  const btts = (mk['29'] || [])[0]
  if (btts) { const yes = btts.outcomes.find(o => /^yes/i.test(o.desc)), no = btts.outcomes.find(o => /^no/i.test(o.desc)); const opts = [yes, no].filter(o => o?.isActive === 1 && +o.odds >= MIN_ODDS); if (opts.length) { const c = [...opts].sort((a, b) => +a.odds - +b.odds)[0]; candidates.push({ market: 'BTTS', outcome: /^yes/i.test(c.desc) ? 'Yes' : 'No', odds: +c.odds, trueProb: +c.probability, rawMarketId: '29', rawSpecifier: '', rawOutcomeId: /^yes/i.test(c.desc) ? '74' : '76' }) } }
  return candidates.sort((a, b) => b.trueProb - a.trueProb)
}

async function pool(items, worker, concurrency = 3) {
  const results = new Array(items.length)
  let idx = 0
  async function next() { while (idx < items.length) { const i = idx++; results[i] = await worker(items[i]) } }
  await Promise.all(Array.from({ length: concurrency }, next))
  return results
}

async function enrich(f) {
  const ev = rawById[f.fixtureId]
  if (!ev) return { ...f, error: 'no raw data' }
  const candidates = bookCandidates(ev)
  if (!candidates.length) return { ...f, error: 'no qualifying market' }
  const bookPick = candidates[0]

  const pair = await fetchTeamResultsPair(ev.homeTeamName, ev.awayTeamName)
  if (!pair || pair.homeResults.length < MIN_GAMES_FOR_FORM || pair.awayResults.length < MIN_GAMES_FOR_FORM) {
    return { ...f, picked: bookPick, formUsed: false, allCandidates: candidates }
  }
  // Staleness guard — see cook-edge-slip.mjs for why: a team's "recent" results can come back
  // over a year old from the API, which produces a form estimate from a different season, not
  // real recent form. Fall back to book-only rather than blend in garbage.
  const STALE_DAYS = 45
  const mostRecent = (results) => Math.max(...results.map(r => new Date(r.date).getTime()))
  const now = Date.now()
  const homeAgeDays = (now - mostRecent(pair.homeResults)) / 86400000
  const awayAgeDays = (now - mostRecent(pair.awayResults)) / 86400000
  if (homeAgeDays > STALE_DAYS || awayAgeDays > STALE_DAYS) {
    return { ...f, picked: bookPick, formUsed: false, staleRejected: true, homeAgeDays: Math.round(homeAgeDays), awayAgeDays: Math.round(awayAgeDays), allCandidates: candidates }
  }
  const lambdas = estimateLambdas(pair.homeResults, pair.awayResults, ev.homeTeamName, ev.awayTeamName)
  const ranked = candidates.map(c => {
    const fp = formProbFor(c.market, lambdas.lambdaHome, lambdas.lambdaAway, c.outcome)
    const formProb = fp == null ? null : typeof fp === 'number' ? fp : (/^home/i.test(c.outcome) ? fp.pHomeWin : fp.pAwayWin)
    const blendProb = formProb == null ? c.trueProb : BOOK_WEIGHT * c.trueProb + FORM_WEIGHT * formProb
    return { ...c, formProb, blendProb }
  }).sort((a, b) => b.blendProb - a.blendProb)
  const picked = ranked[0]
  return { ...f, picked, formUsed: true, historySource: pair.source, changedByForm: picked.market !== bookPick.market || picked.outcome !== bookPick.outcome, bookPick, allCandidates: ranked }
}

console.log(`Enriching ${fixtures.length} fixtures with history+form (this pulls apifootball/SofaScore per team, ~1-2s each)...`)
const enriched = await pool(fixtures, enrich, 3)
await closeHistorySession()

const ok = enriched.filter(e => e.picked)
const skipped = enriched.filter(e => !e.picked)
if (skipped.length) console.log(`Skipped (no data/market): ${skipped.map(s => s.game + ' — ' + s.error).join('; ')}`)

const legs = ok.map(e => ({
  fixtureId: e.fixtureId, game: e.game, league: e.league, kickoff: e.kickoff,
  market: e.picked.market, outcome: e.picked.outcome, odds: e.picked.odds,
  bookProb: e.picked.trueProb, formProb: e.picked.formProb ?? null, blendProb: e.picked.blendProb ?? e.picked.trueProb,
  formUsed: e.formUsed, changedByForm: e.changedByForm ?? false,
  rawMarketId: e.picked.rawMarketId, rawSpecifier: e.picked.rawSpecifier, rawOutcomeId: e.picked.rawOutcomeId,
}))
legs.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))

const combinedOdds = legs.reduce((p, l) => p * l.odds, 1)
const combinedBookProb = legs.reduce((p, l) => p * l.bookProb, 1)
const combinedBlendProb = legs.reduce((p, l) => p * l.blendProb, 1)
console.log(`\n${legs.length} legs, combined odds ${combinedOdds.toFixed(2)}x`)
console.log(`combined book-only probability: ${(combinedBookProb * 100).toFixed(2)}%`)
console.log(`combined book+form blended probability: ${(combinedBlendProb * 100).toFixed(2)}%`)
const formCount = legs.filter(l => l.formUsed).length
const changedCount = legs.filter(l => l.changedByForm).length
console.log(`form data available for ${formCount}/${legs.length} legs; form changed the pick on ${changedCount} of those`)
for (const l of legs) console.log(`[${l.league}] ${l.kickoff}  ${l.game} -> ${l.market} ${l.outcome} @ ${l.odds} (book ${(l.bookProb * 100).toFixed(1)}%${l.formUsed ? `, form ${(l.formProb * 100).toFixed(1)}%, blend ${(l.blendProb * 100).toFixed(1)}%` : ', no history'})${l.changedByForm ? '  <-- form changed pick' : ''}`)

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), note: 'Preview only. Picks blend book odds (60%) with a Poisson form model from real match history (40%).', combinedOdds, combinedBookProb, combinedBlendProb, skipped: skipped.map(s => ({ game: s.game, reason: s.error })), legs }, null, 2))
console.log(`\nWrote ${OUT}`)

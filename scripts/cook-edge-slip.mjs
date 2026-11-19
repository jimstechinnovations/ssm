/**
 * scripts/cook-edge-slip.mjs — like cook-history-blend-slip.mjs but ranks by EDGE
 * (formProb - bookProb), not by raw probability. Only includes games where real match history
 * was found AND the form model meaningfully disagrees with the book price in a positive direction
 * (form thinks it's MORE likely than the market does) — that's the actual "value" signal, not
 * just "which market clears the highest floor". Games with no history, or where form disagrees
 * negatively (form less confident than book — a red flag, not a pick), are excluded, not
 * book-only-fallback included, since the whole point here is edge, not safety-floor picking.
 *
 * Usage:
 *   node scripts/cook-edge-slip.mjs fixtures.json out.json [--minEdge=0.05]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas, formProbFor } from './lib-form-model.mjs'

const [, , inFile, outFile, ...rest] = process.argv
if (!inFile) { console.error('usage: node scripts/cook-edge-slip.mjs fixtures.json [out.json] [--minEdge=0.05]'); process.exit(1) }
const OUT = outFile || 'slip-edge.json'
const minEdgeArg = rest.find(a => a.startsWith('--minEdge='))
const MIN_EDGE = minEdgeArg ? Number(minEdgeArg.split('=')[1]) : 0.05
const fixtures = JSON.parse(readFileSync(inFile, 'utf8'))

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MIN_ODDS = 1.20
const MIN_GAMES_FOR_FORM = 3
const MARKET_IDS = '1,10,11,16,18,19,20,29,60110'

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

function bookCandidates(ev) {
  const mk = {}
  for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (mk[m.id] ??= []).push(m) }
  const candidates = []
  const o15 = (mk['18'] || []).find(m => m.specifier === 'total=1.5')
  if (o15) { const o = o15.outcomes.find(x => /^over/i.test(x.desc)); if (o?.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ market: 'O15', outcome: 'Over 1.5', odds: +o.odds, trueProb: +o.probability, rawMarketId: '18', rawSpecifier: 'total=1.5', rawOutcomeId: '12' }) }
  const u45 = (mk['18'] || []).find(m => m.specifier === 'total=4.5')
  if (u45) { const u = u45.outcomes.find(x => /^under/i.test(x.desc)); if (u?.isActive === 1 && +u.odds >= MIN_ODDS) candidates.push({ market: 'U45', outcome: 'Under 4.5', odds: +u.odds, trueProb: +u.probability, rawMarketId: '18', rawSpecifier: 'total=4.5', rawOutcomeId: '13' }) }
  const dc = (mk['10'] || [])[0]
  if (dc) { for (const o of (dc.outcomes || [])) { if (o.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ market: 'DC', outcome: o.desc, odds: +o.odds, trueProb: +o.probability, rawMarketId: '10', rawSpecifier: '', rawOutcomeId: o.id }) } }
  const dnb = (mk['11'] || [])[0]
  if (dnb) { const home = dnb.outcomes.find(o => /^home/i.test(o.desc)), away = dnb.outcomes.find(o => /^away/i.test(o.desc)); for (const [o, id, label] of [[home, '4', `Home (DNB) [${ev.homeTeamName}]`], [away, '5', `Away (DNB) [${ev.awayTeamName}]`]]) { if (o?.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ market: 'DNB', outcome: label, odds: +o.odds, trueProb: +o.probability, rawMarketId: '11', rawSpecifier: '', rawOutcomeId: id }) } }
  const hcpHalf = (mk['16'] || []).find(m => m.specifier === 'hcp=-0.5' || m.specifier === 'hcp=0.5')
  if (hcpHalf) { const home = hcpHalf.outcomes.find(o => /^home/i.test(o.desc)), away = hcpHalf.outcomes.find(o => /^away/i.test(o.desc)); for (const [o, side] of [[home, ev.homeTeamName], [away, ev.awayTeamName]]) { if (o?.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ market: 'HCP', outcome: `${o.desc} [${side}]`, odds: +o.odds, trueProb: +o.probability, rawMarketId: '16', rawSpecifier: hcpHalf.specifier, rawOutcomeId: o.id }) } }
  const h19 = (mk['19'] || []).find(m => m.specifier === 'total=0.5')
  if (h19) { const o = h19.outcomes.find(x => /^over/i.test(x.desc)); if (o?.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ market: 'HOU05', outcome: `${ev.homeTeamName} Over 0.5`, odds: +o.odds, trueProb: +o.probability, rawMarketId: '19', rawSpecifier: 'total=0.5', rawOutcomeId: '12' }) }
  const a20 = (mk['20'] || []).find(m => m.specifier === 'total=0.5')
  if (a20) { const o = a20.outcomes.find(x => /^over/i.test(x.desc)); if (o?.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ market: 'AOU05', outcome: `${ev.awayTeamName} Over 0.5`, odds: +o.odds, trueProb: +o.probability, rawMarketId: '20', rawSpecifier: 'total=0.5', rawOutcomeId: '12' }) }
  const btts = (mk['29'] || [])[0]
  if (btts) { for (const o of (btts.outcomes || [])) { if (o.isActive === 1 && +o.odds >= MIN_ODDS) candidates.push({ market: 'BTTS', outcome: /^yes/i.test(o.desc) ? 'Yes' : 'No', odds: +o.odds, trueProb: +o.probability, rawMarketId: '29', rawSpecifier: '', rawOutcomeId: o.id }) } }
  return candidates
}

async function pool(items, worker, concurrency = 3) {
  const results = new Array(items.length)
  let idx = 0
  async function next() { while (idx < items.length) { const i = idx++; results[i] = await worker(items[i]) } }
  await Promise.all(Array.from({ length: concurrency }, next))
  return results
}

async function computeEdges(f) {
  const ev = rawById[f.fixtureId]
  if (!ev) return { ...f, skip: 'no raw data' }
  const candidates = bookCandidates(ev)
  if (!candidates.length) return { ...f, skip: 'no qualifying market' }

  const pair = await fetchTeamResultsPair(ev.homeTeamName, ev.awayTeamName)
  if (!pair || pair.homeResults.length < MIN_GAMES_FOR_FORM || pair.awayResults.length < MIN_GAMES_FOR_FORM) {
    return { ...f, skip: 'no history' }
  }
  // Staleness guard: if the most recent match for EITHER side is more than STALE_DAYS old, the
  // API doesn't actually have current data for that team — using it produces a lambda estimate
  // from a different season/context, not real "recent form". Caught this live: Atletico Madrid's
  // "recent" results came back from May 2025 (16 months stale) while Real Madrid's were genuinely
  // current, producing a nonsense edge. Reject rather than silently use stale data.
  const STALE_DAYS = 45
  const mostRecent = (results) => Math.max(...results.map(r => new Date(r.date).getTime()))
  const now = Date.now()
  const homeAgeDays = (now - mostRecent(pair.homeResults)) / 86400000
  const awayAgeDays = (now - mostRecent(pair.awayResults)) / 86400000
  if (homeAgeDays > STALE_DAYS || awayAgeDays > STALE_DAYS) {
    return { ...f, skip: `stale history (home ${homeAgeDays.toFixed(0)}d old, away ${awayAgeDays.toFixed(0)}d old)` }
  }
  const lambdas = estimateLambdas(pair.homeResults, pair.awayResults, ev.homeTeamName, ev.awayTeamName)
  const withEdge = candidates.map(c => {
    const fp = formProbFor(c.market, lambdas.lambdaHome, lambdas.lambdaAway, c.outcome)
    const formProb = fp == null ? null : typeof fp === 'number' ? fp : (/^home/i.test(c.outcome) ? fp.pHomeWin : fp.pAwayWin)
    return { ...c, formProb, edge: formProb == null ? null : formProb - c.trueProb }
  }).filter(c => c.edge != null)
  if (!withEdge.length) return { ...f, skip: 'form model has no coverage for this game\'s markets' }
  withEdge.sort((a, b) => b.edge - a.edge)
  const best = withEdge[0]
  return { ...f, best, historySource: pair.source, allEdges: withEdge }
}

console.log(`Computing form-vs-book edge for ${fixtures.length} fixtures...`)
const results = await pool(fixtures, computeEdges, 3)
await closeHistorySession()

const skipped = results.filter(r => r.skip)
const withEdge = results.filter(r => r.best)
console.log(`\nSkipped (${skipped.length}): ${skipped.map(s => `${s.game} — ${s.skip}`).join('; ')}`)

console.log(`\nAll games with computable edge, ranked:`)
for (const r of [...withEdge].sort((a, b) => b.best.edge - a.best.edge)) {
  console.log(`  ${r.game}: ${r.best.market} ${r.best.outcome} @ ${r.best.odds} — book ${(r.best.trueProb * 100).toFixed(1)}%, form ${(r.best.formProb * 100).toFixed(1)}%, edge ${r.best.edge >= 0 ? '+' : ''}${(r.best.edge * 100).toFixed(1)}pts`)
}

const picked = withEdge.filter(r => r.best.edge >= MIN_EDGE).sort((a, b) => b.best.edge - a.best.edge)
console.log(`\n${picked.length} games clear the +${(MIN_EDGE * 100).toFixed(0)}pt edge bar`)

const legs = picked.map(r => ({
  fixtureId: r.fixtureId, game: r.game, league: r.league, kickoff: r.kickoff,
  market: r.best.market, outcome: r.best.outcome, odds: r.best.odds,
  bookProb: r.best.trueProb, formProb: r.best.formProb, edge: r.best.edge, historySource: r.historySource,
  rawMarketId: r.best.rawMarketId, rawSpecifier: r.best.rawSpecifier, rawOutcomeId: r.best.rawOutcomeId,
}))
legs.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
const combinedOdds = legs.reduce((p, l) => p * l.odds, 1)
const combinedBookProb = legs.reduce((p, l) => p * l.bookProb, 1)
const combinedFormProb = legs.reduce((p, l) => p * l.formProb, 1)
console.log(`\n${legs.length} legs, combined odds ${combinedOdds.toFixed(2)}x, combined book prob ${(combinedBookProb * 100).toFixed(2)}%, combined form prob ${(combinedFormProb * 100).toFixed(2)}%`)
for (const l of legs) console.log(`[${l.league}] ${l.kickoff}  ${l.game} -> ${l.market} ${l.outcome} @ ${l.odds}  (edge +${(l.edge * 100).toFixed(1)}pts, form ${(l.formProb * 100).toFixed(1)}% vs book ${(l.bookProb * 100).toFixed(1)}%)`)

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), note: 'Preview only. Picks are games where recent-form/H2H probability exceeds the book-implied probability by at least the edge threshold — a value signal, not a raw safety floor.', minEdge: MIN_EDGE, combinedOdds, combinedBookProb, combinedFormProb, skipped: skipped.map(s => ({ game: s.game, reason: s.skip })), allRanked: withEdge.map(r => ({ game: r.game, market: r.best.market, outcome: r.best.outcome, odds: r.best.odds, edge: r.best.edge })), legs }, null, 2))
console.log(`\nWrote ${OUT}`)

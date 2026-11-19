/**
 * scripts/cook-safe-edge-slip.mjs — form-verified slip restricted to SAFER markets.
 *
 * Same idea as cook-edge-slip.mjs (real match history + Poisson form model, staleness guard),
 * but instead of chasing the biggest form-vs-book gap it looks for legs where book AND form
 * independently agree the pick is very likely. Markets allowed: Over 1.5, Double Chance,
 * Draw No Bet, team Over 0.5 (home/away), DC 1UP, Draw 0-10min. Excluded on purpose: BTTS (any
 * side), straight win, handicap, and Under 4.5 (banned 2026-10-12 — user call after repeated
 * high-scoring games busting it even on form-backed picks) — the markets that produced the losses.
 *
 * A leg qualifies when: fresh history exists for both teams (<=45 days old), form prob >= MIN_FORM,
 * blended prob (60% book / 40% form) >= MIN_BLEND, and form does not disagree with the book by more
 * than 4 points (plain markets). DC 1UP has no direct form equivalent, so its form check uses the
 * plain Double Chance probability, which is a conservative lower bound for it.
 *
 * Usage: node scripts/cook-safe-edge-slip.mjs --toISO=2026-09-20T22:00:00Z [--fromISO=] [--out=] [--minBlend=0.80] [--minForm=0.75]
 */
import { writeFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas, formProbFor } from './lib-form-model.mjs'

const arg = (n, d = null) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d }
const FROM = arg('fromISO') ? new Date(arg('fromISO')).getTime() : Date.now()
const TO = new Date(arg('toISO')).getTime()
const OUT = arg('out', 'slip-safe-edge.json')
const MIN_BLEND = Number(arg('minBlend', '0.80'))
const MIN_FORM = Number(arg('minForm', '0.75'))
const ALL = process.argv.includes('--all')
const PREFILTER = ALL ? 0 : 0.78
const MIN_ODDS = 1.05
const STALE_DAYS = 45
const MIN_GAMES = 3
const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MARKET_IDS = '10,11,18,19,20,60110,105'

// SportyBet team names ("GNK Dinamo Zagreb", "SC Corinthians SP") often don't match the stats
// source's names ("Dinamo Zagreb", "Corinthians"). Try the raw name, then progressively plainer
// variants, and take each side's results from whichever attempt resolves it.
const LEAD = new Set(['gnk','nk','hnk','fk','kks','rks','mks','sc','ca','cd','csd','cs','fc','cf','ac','as','us','usd','acd','ud','sd','ec','se','sv','tsv','club','sk','ks','bk','if','ik'])
const ALIAS = { 'psg': ['Paris Saint-Germain', 'Paris SG'], 'ac milan': ['Milan'], 'man utd': ['Manchester United'], 'man city': ['Manchester City'] }
function nameVariants(name) {
  const raw = name.replace(/\s+/g, ' ').trim()
  const out = [raw]
  const plain = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[´'`.]/g, '')
  let words = plain.split(' ')
  while (words.length > 1 && LEAD.has(words[0].toLowerCase())) words = words.slice(1)
  while (words.length > 1 && (LEAD.has(words[words.length - 1].toLowerCase()) || /^[A-Z]{2}$/.test(words[words.length - 1]))) words = words.slice(0, -1)
  const stripped = words.join(' ')
  for (const v of [stripped, plain]) if (v && !out.includes(v)) out.push(v)
  for (const a of ALIAS[raw.toLowerCase()] || ALIAS[stripped.toLowerCase()] || []) if (!out.includes(a)) out.push(a)
  return out
}
async function resolvePair(home, away) {
  const hv = nameVariants(home), av = nameVariants(away)
  let H = null, A = null, source = null
  const tried = new Set()
  const n = Math.max(hv.length, av.length)
  for (let i = 0; i < n && (!H || !A); i++) {
    const h = hv[Math.min(i, hv.length - 1)], a = av[Math.min(i, av.length - 1)]
    if (tried.has(h + '|' + a)) continue
    tried.add(h + '|' + a)
    const p = await fetchTeamResultsPair(h, a)
    if (!p) continue
    if (!H && p.homeResults.length >= MIN_GAMES) H = p.homeResults
    if (!A && p.awayResults.length >= MIN_GAMES) A = p.awayResults
    source = p.source
  }
  return H && A ? { homeResults: H, awayResults: A, source } : null
}

const isSim = (t, ev) => /simulat/i.test(t.category?.name || '') || /\bsrl\b/i.test((ev.homeTeamName || '') + (ev.awayTeamName || ''))

function candidatesFor(ev) {
  const mk = {}
  for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (mk[m.id] ??= []).push(m) }
  const c = []
  const add = (o, x) => { if (o?.isActive === 1 && +o.odds >= MIN_ODDS) c.push({ ...x, odds: +o.odds, bookProb: +o.probability }) }
  const line = (id, spec) => (mk[id] || []).find(m => m.specifier === spec)
  const o15 = line('18', 'total=1.5'); if (o15) add(o15.outcomes.find(x => /^over/i.test(x.desc)), { market: 'O15', outcome: 'Over 1.5', rawMarketId: '18', rawSpecifier: 'total=1.5', rawOutcomeId: '12' })
  // Under 4.5 banned 2026-10-12 — no longer added as a candidate.
  const h19 = line('19', 'total=0.5'); if (h19) add(h19.outcomes.find(x => /^over/i.test(x.desc)), { market: 'HOU05', outcome: `${ev.homeTeamName} Over 0.5`, rawMarketId: '19', rawSpecifier: 'total=0.5', rawOutcomeId: '12' })
  const a20 = line('20', 'total=0.5'); if (a20) add(a20.outcomes.find(x => /^over/i.test(x.desc)), { market: 'AOU05', outcome: `${ev.awayTeamName} Over 0.5`, rawMarketId: '20', rawSpecifier: 'total=0.5', rawOutcomeId: '12' })
  const dc = (mk['10'] || [])[0]; if (dc) for (const o of dc.outcomes || []) add(o, { market: 'DC', outcome: o.desc, rawMarketId: '10', rawSpecifier: '', rawOutcomeId: o.id })
  const dnb = (mk['11'] || [])[0]; if (dnb) for (const o of dnb.outcomes || []) add(o, { market: 'DNB', outcome: `${/^home/i.test(o.desc) ? 'Home' : 'Away'} (DNB) [${/^home/i.test(o.desc) ? ev.homeTeamName : ev.awayTeamName}]`, rawMarketId: '11', rawSpecifier: '', rawOutcomeId: /^home/i.test(o.desc) ? '4' : '5' })
  const d1 = (mk['60110'] || [])[0]; if (d1) for (const o of d1.outcomes || []) add(o, { market: 'DC1UP', outcome: `${o.desc} (1UP)`, rawMarketId: '60110', rawSpecifier: '', rawOutcomeId: o.id })
  const d10 = line('105', 'from=1|to=10'); if (d10) add(d10.outcomes.find(x => /draw/i.test(x.desc)), { market: 'DRAW10', outcome: 'Draw (0-10 min)', rawMarketId: '105', rawSpecifier: 'from=1|to=10', rawOutcomeId: '2' })
  return c
}

console.log(`Window ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()}`)
const fixtures = []
for (let pg = 1; pg <= 30; pg++) {
  const res = await fetch(`${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=${MARKET_IDS}&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  for (const t of json.data.tournaments) for (const ev of t.events || []) {
    if (isSim(t, ev) || ev.estimateStartTime < FROM || ev.estimateStartTime > TO) continue
    const cands = candidatesFor(ev)
    if (!cands.length || Math.max(...cands.map(x => x.bookProb)) < PREFILTER) continue
    fixtures.push({ fixtureId: Number(String(ev.eventId).split(':').pop()), game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, home: ev.homeTeamName, away: ev.awayTeamName, league: t.name, kickoff: new Date(ev.estimateStartTime).toISOString(), cands })
  }
}
const fixturesUniq = [...new Map(fixtures.map(f => [f.fixtureId, f])).values()]
console.log(`${fixturesUniq.length} fixtures pass the book prefilter (>= ${PREFILTER * 100}% on some safe market); checking history...`)

async function pool(items, worker, n = 3) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await worker(items[k]) } }))
  return out
}

// 2026-10-11: two tickets cut by DC "Home or Away" losing to a high-scoring draw, both odds-only
// (no form signal) picks. Home-or-Away is the only DC variant that loses on any draw, so it's
// penalized when there's no form backing to confirm a real favorite.
const HOA_UNVERIFIED_PENALTY = 0.05
const rankKey = c => {
  let k = 0
  if ((c.market === 'DC' || c.market === 'DC1UP') && /home or away/i.test(c.outcome) && c.formProb == null) k -= HOA_UNVERIFIED_PENALTY
  return k
}
const bookOnlyPick = f => [...f.cands].sort((a, b) => (b.bookProb + rankKey(b)) - (a.bookProb + rankKey(a)))[0]
const reasons = {}
const bump = r => { reasons[r] = (reasons[r] || 0) + 1 }
const evaluated = await pool(fixturesUniq, async f => {
  const pair = await resolvePair(f.home, f.away)
  if (!pair) { bump('no history'); return ALL ? { ...f, pick: { ...bookOnlyPick(f), blend: bookOnlyPick(f).bookProb, formProb: null }, verified: false } : null }
  const newest = r => Math.max(...r.map(x => new Date(x.date).getTime()))
  const ageH = (Date.now() - newest(pair.homeResults)) / 864e5, ageA = (Date.now() - newest(pair.awayResults)) / 864e5
  if (ageH > STALE_DAYS || ageA > STALE_DAYS) { bump('stale history'); return ALL ? { ...f, pick: { ...bookOnlyPick(f), blend: bookOnlyPick(f).bookProb, formProb: null }, verified: false } : null }
  const lam = estimateLambdas(pair.homeResults, pair.awayResults, f.home, f.away)
  const scored = [], looser = []
  for (const c of f.cands) {
    const fm = c.market === 'DC1UP' ? 'DC' : c.market
    const fp = formProbFor(fm, lam.lambdaHome, lam.lambdaAway, c.outcome.replace(/ \(1UP\)$/, ''))
    const formProb = fp == null ? null : typeof fp === 'number' ? fp : (/^home/i.test(c.outcome) ? fp.pHomeWin : fp.pAwayWin)
    if (formProb == null) { looser.push({ ...c, formProb: null, blend: c.bookProb }); continue }
    const blend = 0.6 * c.bookProb + 0.4 * formProb
    const agrees = c.market === 'DC1UP' ? true : formProb >= c.bookProb - 0.04
    if (formProb >= MIN_FORM && blend >= MIN_BLEND && agrees) scored.push({ ...c, formProb, blend })
    else looser.push({ ...c, formProb, blend })
  }
  if (!scored.length) { bump('no leg cleared the safety bar'); if (!ALL) return null; if (!looser.length) return { ...f, pick: { ...bookOnlyPick(f), blend: bookOnlyPick(f).bookProb, formProb: null }, verified: false }; looser.sort((a, b) => (b.blend + rankKey(b)) - (a.blend + rankKey(a))); return { ...f, pick: looser[0], historySource: pair.source, verified: true } }
  scored.sort((a, b) => (b.blend + rankKey(b)) - (a.blend + rankKey(a)))
  return { ...f, pick: scored[0], historySource: pair.source, verified: true }
}, 3)
await closeHistorySession()

const picks = evaluated.filter(Boolean).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
console.log('excluded because:', JSON.stringify(reasons))
let legs = picks.map(p => ({ fixtureId: p.fixtureId, game: p.game, league: p.league, kickoff: p.kickoff, market: p.pick.market, outcome: p.pick.outcome, odds: p.pick.odds, bookProb: p.pick.bookProb, formProb: p.pick.formProb, blendProb: p.pick.blend, verified: !!p.verified, rawMarketId: p.pick.rawMarketId, rawSpecifier: p.pick.rawSpecifier, rawOutcomeId: p.pick.rawOutcomeId }))
const combinedOdds = legs.reduce((p, l) => p * l.odds, 1)
const combinedProb = legs.reduce((p, l) => p * l.blendProb, 1)
console.log(`\n${legs.length} legs, combined odds ${combinedOdds.toFixed(2)}x, combined blended probability ${(combinedProb * 100).toFixed(2)}%`)
for (const l of legs) console.log(`${l.kickoff.slice(11, 16)} ${l.game} [${l.league}] -> ${l.market} ${l.outcome} @ ${l.odds}  book ${(l.bookProb * 100).toFixed(1)}%${l.verified && l.formProb != null ? ' / form ' + (l.formProb * 100).toFixed(1) + '% / blend ' + (l.blendProb * 100).toFixed(1) + '%  [form-checked]' : '  [odds only]'}`)
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), note: 'Preview only. Form-verified safer-market slip: no BTTS, no straight win, no handicap.', combinedOdds, combinedBlendProbability: combinedProb, minBlend: MIN_BLEND, minForm: MIN_FORM, legs }, null, 2))
console.log(`Wrote ${OUT}`)

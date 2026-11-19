/**
 * One-off: same window/fixtures as the 1-3pm Rwanda slip, but per fixture pick whichever
 * safe-market candidate has the HIGHEST ODDS (not highest probability), subject to a loosened
 * floor (blend >= 0.50 instead of 0.72), to push combined odds toward a 10,000x target.
 * This is a one-time loosening per explicit user request — not a change to the standard script.
 */
import { writeFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas, formProbFor } from './lib-form-model.mjs'

const FROM = new Date('2026-10-08T11:00:00Z').getTime()
const TO = new Date('2026-10-08T13:00:00Z').getTime()
const MIN_ODDS = 1.02
const STALE_DAYS = 45
const MIN_GAMES = 3
const LOOSE_FLOOR = 0.50
const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MARKET_IDS = '10,11,18,19,20,60110'

const LEAD = new Set(['gnk','nk','hnk','fk','kks','rks','mks','sc','ca','cd','csd','cs','fc','cf','ac','as','us','usd','acd','ud','sd','ec','se','sv','tsv','club','sk','ks','bk','if','ik'])
function nameVariants(name) {
  const raw = name.replace(/\s+/g, ' ').trim()
  const out = [raw]
  const plain = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[´'`.]/g, '')
  let words = plain.split(' ')
  while (words.length > 1 && LEAD.has(words[0].toLowerCase())) words = words.slice(1)
  while (words.length > 1 && (LEAD.has(words[words.length - 1].toLowerCase()) || /^[A-Z]{2}$/.test(words[words.length - 1]))) words = words.slice(0, -1)
  const stripped = words.join(' ')
  for (const v of [stripped, plain]) if (v && !out.includes(v)) out.push(v)
  return out
}
async function resolvePair(home, away) {
  const hv = nameVariants(home), av = nameVariants(away)
  let H = null, A = null
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
  }
  return H && A ? { homeResults: H, awayResults: A } : null
}
const isSim = (t, ev) => /simulat/i.test(t.category?.name || '') || /\bsrl\b/i.test((ev.homeTeamName || '') + (ev.awayTeamName || ''))

function candidatesFor(ev) {
  const mk = {}
  for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (mk[m.id] ??= []).push(m) }
  const c = []
  const add = (o, x) => { if (o?.isActive === 1 && +o.odds >= MIN_ODDS) c.push({ ...x, odds: +o.odds, bookProb: +o.probability }) }
  const line = (id, spec) => (mk[id] || []).find(m => m.specifier === spec)
  const o15 = line('18', 'total=1.5'); if (o15) add(o15.outcomes.find(x => /^over/i.test(x.desc)), { market: 'O15', outcome: 'Over 1.5', rawMarketId: '18', rawSpecifier: 'total=1.5', rawOutcomeId: '12' })
  const u45 = line('18', 'total=4.5'); if (u45) add(u45.outcomes.find(x => /^under/i.test(x.desc)), { market: 'U45', outcome: 'Under 4.5', rawMarketId: '18', rawSpecifier: 'total=4.5', rawOutcomeId: '13' })
  const h19 = line('19', 'total=0.5'); if (h19) add(h19.outcomes.find(x => /^over/i.test(x.desc)), { market: 'HOU05', outcome: `${ev.homeTeamName} Over 0.5`, rawMarketId: '19', rawSpecifier: 'total=0.5', rawOutcomeId: '12' })
  const a20 = line('20', 'total=0.5'); if (a20) add(a20.outcomes.find(x => /^over/i.test(x.desc)), { market: 'AOU05', outcome: `${ev.awayTeamName} Over 0.5`, rawMarketId: '20', rawSpecifier: 'total=0.5', rawOutcomeId: '12' })
  const dc = (mk['10'] || [])[0]; if (dc) for (const o of dc.outcomes || []) add(o, { market: 'DC', outcome: o.desc, rawMarketId: '10', rawSpecifier: '', rawOutcomeId: o.id })
  const d1 = (mk['60110'] || [])[0]; if (d1) for (const o of d1.outcomes || []) add(o, { market: 'DC1UP', outcome: `${o.desc} (1UP)`, rawMarketId: '60110', rawSpecifier: '', rawOutcomeId: o.id })
  return c
}

console.log(`Window ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()} — LOOSENED floor (${LOOSE_FLOOR * 100}%), maximizing odds per fixture`)
const fixtures = []
for (let pg = 1; pg <= 30; pg++) {
  const res = await fetch(`${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=${MARKET_IDS}&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  for (const t of json.data.tournaments) for (const ev of t.events || []) {
    if (isSim(t, ev) || ev.estimateStartTime < FROM || ev.estimateStartTime > TO || ev.estimateStartTime < Date.now() + 3 * 60000) continue
    const cands = candidatesFor(ev)
    if (!cands.length) continue
    fixtures.push({ fixtureId: Number(String(ev.eventId).split(':').pop()), game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, home: ev.homeTeamName, away: ev.awayTeamName, league: t.name, kickoff: new Date(ev.estimateStartTime).toISOString(), cands })
  }
}
const uniq = [...new Map(fixtures.map(f => [f.fixtureId, f])).values()]
console.log(`${uniq.length} fixtures in window`)

async function pool(items, worker, n = 4) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await worker(items[k]) } }))
  return out
}

const picked = (await pool(uniq, async f => {
  let lam = null
  try {
    const pair = await resolvePair(f.home, f.away)
    if (pair) {
      const newest = r => Math.max(...r.map(x => new Date(x.date).getTime()))
      const ok = [pair.homeResults, pair.awayResults].every(r => (Date.now() - newest(r)) / 864e5 <= STALE_DAYS)
      if (ok) lam = estimateLambdas(pair.homeResults, pair.awayResults, f.home, f.away)
    }
  } catch {}
  const scored = f.cands.map(c => {
    let formProb = null
    if (lam) {
      const fm = c.market === 'DC1UP' ? 'DC' : c.market
      const fp = formProbFor(fm, lam.lambdaHome, lam.lambdaAway, c.outcome.replace(/ \(1UP\)$/, ''))
      formProb = fp == null ? null : typeof fp === 'number' ? fp : (/^home/i.test(c.outcome) ? fp.pHomeWin : fp.pAwayWin)
    }
    const blend = formProb == null ? c.bookProb : 0.6 * c.bookProb + 0.4 * formProb
    return { ...c, formProb, blend, verified: formProb != null }
  }).filter(c => c.blend >= LOOSE_FLOOR)
  if (!scored.length) return null
  scored.sort((a, b) => b.odds - a.odds)
  return { ...f, pick: scored[0] }
}, 4))

await closeHistorySession()
const qualifying = picked.filter(Boolean).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
const legs = qualifying.map(p => ({ fixtureId: p.fixtureId, game: p.game, league: p.league, kickoff: p.kickoff, market: p.pick.market, outcome: p.pick.outcome, odds: p.pick.odds, bookProb: p.pick.bookProb, formProb: p.pick.formProb, blendProb: p.pick.blend, verified: p.pick.verified, rawMarketId: p.pick.rawMarketId, rawSpecifier: p.pick.rawSpecifier, rawOutcomeId: p.pick.rawOutcomeId }))
const combinedOdds = legs.reduce((pr, l) => pr * l.odds, 1)
const combinedProb = legs.reduce((pr, l) => pr * l.blendProb, 1)
console.log(`\n${legs.length} legs, combined odds ${combinedOdds.toFixed(2)}x, combined blended probability ${(combinedProb * 100).toFixed(4)}%`)
for (const l of legs) console.log(`${l.kickoff.slice(5, 16)}Z ${l.game} [${l.league}] -> ${l.market} ${l.outcome} @ ${l.odds}  blend ${(l.blendProb * 100).toFixed(0)}%${l.verified ? ' [F]' : ' [odds only]'}`)
writeFileSync('slip-10k-loose.json', JSON.stringify({ generatedAt: new Date().toISOString(), note: 'Preview only. One-off loosened-floor build (blend>=50%), max-odds-per-fixture.', combinedOdds, combinedBlendProbability: combinedProb, legs }, null, 2))
console.log('Wrote slip-10k-loose.json')

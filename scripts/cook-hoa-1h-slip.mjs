/**
 * scripts/cook-hoa-1h-slip.mjs — per game, pick the better of two markets:
 *   (a) Double Chance "Home or Away" (no draw)   marketId 10, outcome 10
 *   (b) 1st Half Over 0.5 goals                   marketId 68, total=0.5, outcome 12
 * "Better" = higher blended probability (60% book / 40% form when fresh history exists, else book only).
 * Usage: node scripts/cook-hoa-1h-slip.mjs --fromISO=2026-09-20T22:30:00Z --toISO=2026-09-21T02:00:00Z [--max=50] [--out=]
 */
import { writeFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas, formProbFor } from './lib-form-model.mjs'

const arg = (n, d = null) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d }
const FROM = arg('fromISO') ? new Date(arg('fromISO')).getTime() : Date.now()
const TO = new Date(arg('toISO')).getTime()
const MAX = Number(arg('max', '50'))
const OUT = arg('out', 'slip-hoa-1h.json')
const STALE_DAYS = 45
const MIN_GAMES = 3
const FIRST_HALF_SHARE = 0.44
const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

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
  const c = []
  for (const m of ev.markets || []) {
    if (m.status !== undefined && m.status !== 0) continue
    if (m.id === '10') {
      const o = (m.outcomes || []).find(x => /home or away/i.test(x.desc))
      if (o?.isActive === 1) c.push({ market: 'HOA', outcome: 'Home or Away', odds: +o.odds, bookProb: +o.probability, rawMarketId: '10', rawSpecifier: '', rawOutcomeId: o.id })
    }
    if (m.id === '68' && m.specifier === 'total=0.5') {
      const o = (m.outcomes || []).find(x => /^over/i.test(x.desc))
      if (o?.isActive === 1) c.push({ market: 'H1O05', outcome: '1st Half Over 0.5', odds: +o.odds, bookProb: +o.probability, rawMarketId: '68', rawSpecifier: 'total=0.5', rawOutcomeId: '12' })
    }
  }
  return c
}

console.log(`Window ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()}`)
const fixtures = []
for (let pg = 1; pg <= 30; pg++) {
  const res = await fetch(`${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=10,68&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
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
console.log(`${uniq.length} fixtures with at least one of the two markets; checking history...`)

async function pool(items, worker, n = 4) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await worker(items[k]) } }))
  return out
}

const stats = { formChecked: 0, oddsOnly: 0 }
const picks = (await pool(uniq, async f => {
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
      if (c.market === 'HOA') { const fp = formProbFor('DC', lam.lambdaHome, lam.lambdaAway, 'Home or Away'); if (typeof fp === 'number') formProb = fp }
      else formProb = 1 - Math.exp(-FIRST_HALF_SHARE * (lam.lambdaHome + lam.lambdaAway))
    }
    const blend = formProb == null ? c.bookProb : 0.6 * c.bookProb + 0.4 * formProb
    return { ...c, formProb, blend }
  }).sort((a, b) => b.blend - a.blend)
  return { ...f, pick: scored[0], other: scored[1] || null }
}, 4))
await closeHistorySession()

const ranked = picks.filter(Boolean).sort((a, b) => b.pick.blend - a.pick.blend)
const chosen = ranked.slice(0, MAX).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
const legs = chosen.map(p => ({ fixtureId: p.fixtureId, game: p.game, league: p.league, kickoff: p.kickoff, market: p.pick.market, outcome: p.pick.outcome, odds: p.pick.odds, bookProb: p.pick.bookProb, formProb: p.pick.formProb, blendProb: p.pick.blend, verified: p.pick.formProb != null, rawMarketId: p.pick.rawMarketId, rawSpecifier: p.pick.rawSpecifier, rawOutcomeId: p.pick.rawOutcomeId }))
const combinedOdds = legs.reduce((p, l) => p * l.odds, 1)
const combinedProb = legs.reduce((p, l) => p * l.blendProb, 1)
console.log(`\n${ranked.length} games available, ${legs.length} legs kept (best by blended probability), combined odds ${combinedOdds.toFixed(2)}x, all-win probability ${(combinedProb * 100).toFixed(3)}%`)
for (const l of legs) console.log(`${l.kickoff.slice(11, 16)}Z ${l.game} [${l.league}] -> ${l.outcome} @ ${l.odds}  book ${(l.bookProb * 100).toFixed(0)}%${l.verified ? ' form ' + (l.formProb * 100).toFixed(0) + '% blend ' + (l.blendProb * 100).toFixed(0) + '% [F]' : ' [odds only]'}`)
const dropped = ranked.slice(MAX)
if (dropped.length) console.log(`\nLeft out (${dropped.length}): ` + dropped.map(p => `${p.game} ${(p.pick.blend * 100).toFixed(0)}%`).join(' | '))
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), note: 'Preview only. Per game: better of DC Home-or-Away vs 1st Half Over 0.5.', combinedOdds, combinedBlendProbability: combinedProb, legs }, null, 2))
console.log(`Wrote ${OUT}`)

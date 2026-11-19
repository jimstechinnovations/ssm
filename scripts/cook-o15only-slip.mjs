/**
 * scripts/cook-u45only-slip.mjs — every leg is Over 1.5, form-checked where possible.
 * Usage: node scripts/cook-u45only-slip.mjs --fromISO= --toISO= --out= [--minBlend=0.72]
 */
import { writeFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas, formProbFor } from './lib-form-model.mjs'

const arg = (n, d = null) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d }
const FROM = arg('fromISO') ? new Date(arg('fromISO')).getTime() : Date.now()
const TO = new Date(arg('toISO')).getTime()
const OUT = arg('out', 'slip-u45only.json')
const MIN_BLEND = Number(arg('minBlend', '0.72'))
const MIN_ODDS = 1.01
const STALE_DAYS = 45
const MIN_GAMES = 3
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

console.log(`Window ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()} — Over 1.5 only`)
const fixtures = []
for (let pg = 1; pg <= 30; pg++) {
  const res = await fetch(`${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=18&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  for (const t of json.data.tournaments) for (const ev of t.events || []) {
    if (isSim(t, ev) || ev.estimateStartTime < FROM || ev.estimateStartTime > TO || ev.estimateStartTime < Date.now() + 3 * 60000) continue
    const m = (ev.markets || []).find(x => x.id === '18' && x.specifier === 'total=1.5' && (x.status === undefined || x.status === 0))
    if (!m) continue
    const u = m.outcomes.find(x => /^over/i.test(x.desc))
    if (!u || u.isActive !== 1 || +u.odds < MIN_ODDS) continue
    fixtures.push({ fixtureId: Number(String(ev.eventId).split(':').pop()), game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, home: ev.homeTeamName, away: ev.awayTeamName, league: t.name, kickoff: new Date(ev.estimateStartTime).toISOString(), odds: +u.odds, bookProb: +u.probability, rawMarketId: '18', rawSpecifier: 'total=1.5', rawOutcomeId: '12' })
  }
}
const uniq = [...new Map(fixtures.map(f => [f.fixtureId, f])).values()]
console.log(`${uniq.length} fixtures with Over 1.5 offered; checking history...`)

async function pool(items, worker, n = 4) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await worker(items[k]) } }))
  return out
}

const picked = (await pool(uniq, async f => {
  let formProb = null, verified = false
  try {
    const pair = await resolvePair(f.home, f.away)
    if (pair) {
      const newest = r => Math.max(...r.map(x => new Date(x.date).getTime()))
      const ageH = (Date.now() - newest(pair.homeResults)) / 864e5, ageA = (Date.now() - newest(pair.awayResults)) / 864e5
      if (ageH <= STALE_DAYS && ageA <= STALE_DAYS) {
        const lam = estimateLambdas(pair.homeResults, pair.awayResults, f.home, f.away)
        const fp = formProbFor('O15', lam.lambdaHome, lam.lambdaAway, 'Over 1.5')
        if (typeof fp === 'number') { formProb = fp; verified = true }
      }
    }
  } catch {}
  const blend = formProb == null ? f.bookProb : 0.6 * f.bookProb + 0.4 * formProb
  return { ...f, formProb, blend, verified }
}, 4))
await closeHistorySession()

const qualifying = picked.filter(p => p.blend >= MIN_BLEND).sort((a, b) => b.blend - a.blend)
qualifying.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
const legs = qualifying.map(p => ({ fixtureId: p.fixtureId, game: p.game, league: p.league, kickoff: p.kickoff, market: 'O15', outcome: 'Over 1.5', odds: p.odds, bookProb: p.bookProb, formProb: p.formProb, blendProb: p.blend, verified: p.verified, rawMarketId: p.rawMarketId, rawSpecifier: p.rawSpecifier, rawOutcomeId: p.rawOutcomeId }))
const combinedOdds = legs.reduce((pr, l) => pr * l.odds, 1)
const combinedProb = legs.reduce((pr, l) => pr * l.blendProb, 1)
console.log(`\n${legs.length} legs (all Over 1.5), combined odds ${combinedOdds.toFixed(2)}x, combined blended probability ${(combinedProb * 100).toFixed(3)}%`)
for (const l of legs) console.log(`${l.kickoff.slice(5, 16)}Z ${l.game} [${l.league}] @ ${l.odds}  book ${(l.bookProb * 100).toFixed(0)}%${l.verified ? ' form ' + (l.formProb * 100).toFixed(0) + '% blend ' + (l.blendProb * 100).toFixed(0) + '% [F]' : ' [odds only]'}`)
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), note: 'Preview only. All legs Over 1.5.', combinedOdds, combinedBlendProbability: combinedProb, legs }, null, 2))
console.log(`Wrote ${OUT}`)

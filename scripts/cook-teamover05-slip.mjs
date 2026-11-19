/**
 * scripts/cook-teamover05-slip.mjs — every leg is "the better/favored team scores at least 1 goal"
 * (team Over 0.5: marketId 19 home / 20 away, specifier total=0.5). Per game, picks whichever side
 * (home or away) is the stronger team by blended probability (book + form where available) — not
 * both, and not forced to be the home side.
 * Usage: node scripts/cook-teamover05-slip.mjs --fromISO= --toISO= --out= [--minBlend=0.70]
 */
import { writeFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas } from './lib-form-model.mjs'

const arg = (n, d = null) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d }
const FROM = arg('fromISO') ? new Date(arg('fromISO')).getTime() : Date.now()
const TO = new Date(arg('toISO')).getTime()
const OUT = arg('out', 'slip-teamover05.json')
const MIN_BLEND = Number(arg('minBlend', '0.70'))
const MIN_ODDS = 1.02
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

console.log(`Window ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()} — favored team Over 0.5 only`)
const fixtures = []
for (let pg = 1; pg <= 30; pg++) {
  const res = await fetch(`${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=19,20&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  for (const t of json.data.tournaments) for (const ev of t.events || []) {
    if (isSim(t, ev) || ev.estimateStartTime < FROM || ev.estimateStartTime > TO || ev.estimateStartTime < Date.now() + 3 * 60000) continue
    const h19 = (ev.markets || []).find(m => m.id === '19' && m.specifier === 'total=0.5' && (m.status === undefined || m.status === 0))
    const a20 = (ev.markets || []).find(m => m.id === '20' && m.specifier === 'total=0.5' && (m.status === undefined || m.status === 0))
    const cands = []
    if (h19) { const o = h19.outcomes.find(x => /^over/i.test(x.desc)); if (o?.isActive === 1 && +o.odds >= MIN_ODDS) cands.push({ side: 'home', odds: +o.odds, bookProb: +o.probability, rawMarketId: '19', rawOutcomeId: '12' }) }
    if (a20) { const o = a20.outcomes.find(x => /^over/i.test(x.desc)); if (o?.isActive === 1 && +o.odds >= MIN_ODDS) cands.push({ side: 'away', odds: +o.odds, bookProb: +o.probability, rawMarketId: '20', rawOutcomeId: '12' }) }
    if (!cands.length) continue
    fixtures.push({ fixtureId: Number(String(ev.eventId).split(':').pop()), game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, home: ev.homeTeamName, away: ev.awayTeamName, league: t.name, kickoff: new Date(ev.estimateStartTime).toISOString(), cands })
  }
}
const uniq = [...new Map(fixtures.map(f => [f.fixtureId, f])).values()]
console.log(`${uniq.length} fixtures with a team-Over-0.5 line; checking history...`)

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
    if (lam) { const lambda = c.side === 'home' ? lam.lambdaHome : lam.lambdaAway; formProb = 1 - Math.exp(-lambda) }
    const blend = formProb == null ? c.bookProb : 0.6 * c.bookProb + 0.4 * formProb
    return { ...c, formProb, blend, verified: formProb != null }
  }).sort((a, b) => b.blend - a.blend)
  return { ...f, pick: scored[0] }
}, 4))
await closeHistorySession()

const qualifying = picked.filter(p => p.pick.blend >= MIN_BLEND).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
const legs = qualifying.map(p => ({ fixtureId: p.fixtureId, game: p.game, league: p.league, kickoff: p.kickoff, market: p.pick.side === 'home' ? 'HOU05' : 'AOU05', outcome: `${p.pick.side === 'home' ? p.home : p.away} Over 0.5`, odds: p.pick.odds, bookProb: p.pick.bookProb, formProb: p.pick.formProb, blendProb: p.pick.blend, verified: p.pick.verified, rawMarketId: p.pick.rawMarketId, rawSpecifier: 'total=0.5', rawOutcomeId: p.pick.rawOutcomeId }))
const combinedOdds = legs.reduce((pr, l) => pr * l.odds, 1)
const combinedProb = legs.reduce((pr, l) => pr * l.blendProb, 1)
console.log(`\n${legs.length} legs (favored team Over 0.5), combined odds ${combinedOdds.toFixed(2)}x, combined blended probability ${(combinedProb * 100).toFixed(3)}%`)
for (const l of legs) console.log(`${l.kickoff.slice(5, 16)}Z ${l.game} [${l.league}] -> ${l.outcome} @ ${l.odds}  book ${(l.bookProb * 100).toFixed(0)}%${l.verified ? ' form ' + (l.formProb * 100).toFixed(0) + '% blend ' + (l.blendProb * 100).toFixed(0) + '% [F]' : ' [odds only]'}`)
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), note: 'Preview only. Favored team Over 0.5 per game.', combinedOdds, combinedBlendProbability: combinedProb, legs }, null, 2))
console.log(`Wrote ${OUT}`)

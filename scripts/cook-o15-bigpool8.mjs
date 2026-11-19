import { readFileSync, writeFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas, formProbFor } from './lib-form-model.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MIN_ODDS = 1.01
const STALE_DAYS = 45
const MIN_GAMES = 3
const targets = new Set(JSON.parse(readFileSync('.bigpool-to-nov8.json', 'utf8')).map(t => t.fixtureId))

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
  const n = Math.max(hv.length, av.length)
  const tried = new Set()
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

const out = new Map()
for (let pg = 1; pg <= 60; pg++) {
  const res = await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr:sport:1&marketId=18&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) for (const ev of t.events || []) {
    pageEvents++
    const fid = Number(String(ev.eventId).split(':').pop())
    if (!targets.has(fid)) continue
    const m = (ev.markets || []).find(x => x.id === '18' && x.specifier === 'total=1.5' && (x.status === undefined || x.status === 0))
    if (!m) continue
    const o = m.outcomes.find(x => /^over/i.test(x.desc))
    if (!o || o.isActive !== 1 || +o.odds < MIN_ODDS) continue
    out.set(fid, { fixtureId: fid, home: ev.homeTeamName, away: ev.awayTeamName, game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, league: t.name, kickoff: new Date(ev.estimateStartTime).toISOString(), odds: +o.odds, bookProb: +o.probability, rawOutcomeId: o.id })
  }
  if (pageEvents === 0 || out.size >= targets.size) break
}
console.log(`Pulled Over 1.5 for ${out.size} of ${targets.size} target games`)

async function pool(items, worker, n = 4) {
  const res = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await worker(items[k]) } }))
  return res
}

const evaluated = await pool([...out.values()], async f => {
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
}, 4)
await closeHistorySession()

const legs = evaluated.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff)).map(p => ({ fixtureId: p.fixtureId, game: p.game, league: p.league, kickoff: p.kickoff, market: 'O15', outcome: 'Over 1.5', odds: p.odds, bookProb: p.bookProb, formProb: p.formProb, blendProb: p.blend, verified: p.verified, rawMarketId: '18', rawSpecifier: 'total=1.5', rawOutcomeId: p.rawOutcomeId }))
writeFileSync('slip-o15-bigpool.json', JSON.stringify({ legs }, null, 2))
console.log(`Wrote ${legs.length} legs to slip-o15-bigpool.json`)

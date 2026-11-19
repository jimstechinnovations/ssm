import { writeFileSync, readFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas, formProbFor } from './lib-form-model.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MIN_ODDS = 1.02
const STALE_DAYS = 45
const MIN_GAMES = 3
const targets = JSON.parse(readFileSync('.uefa-cl.json', 'utf8'))
const targetIds = new Set(targets.map(t => t.fixtureId))
const U45_PENALTY = 0.06
const rankKey = m => (m === 'U45' ? -U45_PENALTY : 0)

function candidatesFor(ev) {
  const mk = {}
  for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (mk[m.id] ??= []).push(m) }
  const c = []
  const add = (o, x) => { if (o?.isActive === 1 && +o.odds >= MIN_ODDS) c.push({ ...x, odds: +o.odds, bookProb: +o.probability, rawOutcomeId: o.id }) }
  const line = (id, spec) => (mk[id] || []).find(m => m.specifier === spec)
  const o15 = line('18', 'total=1.5'); if (o15) add(o15.outcomes.find(x => /^over/i.test(x.desc)), { market: 'O15', outcome: 'Over 1.5', rawMarketId: '18', rawSpecifier: 'total=1.5' })
  const u45 = line('18', 'total=4.5'); if (u45) add(u45.outcomes.find(x => /^under/i.test(x.desc)), { market: 'U45', outcome: 'Under 4.5', rawMarketId: '18', rawSpecifier: 'total=4.5' })
  const h19 = line('19', 'total=0.5'); if (h19) add(h19.outcomes.find(x => /^over/i.test(x.desc)), { market: 'HOU05', outcome: `${ev.homeTeamName} Over 0.5`, rawMarketId: '19', rawSpecifier: 'total=0.5' })
  const a20 = line('20', 'total=0.5'); if (a20) add(a20.outcomes.find(x => /^over/i.test(x.desc)), { market: 'AOU05', outcome: `${ev.awayTeamName} Over 0.5`, rawMarketId: '20', rawSpecifier: 'total=0.5' })
  const dc = (mk['10'] || [])[0]; if (dc) for (const o of dc.outcomes || []) add(o, { market: 'DC', outcome: o.desc, rawMarketId: '10', rawSpecifier: '' })
  const d1 = (mk['60110'] || [])[0]; if (d1) for (const o of d1.outcomes || []) add(o, { market: 'DC1UP', outcome: o.desc + ' (1UP)', rawMarketId: '60110', rawSpecifier: '' })
  const d10 = line('105', 'from=1|to=10'); if (d10) add(d10.outcomes.find(x => /draw/i.test(x.desc)), { market: 'DRAW10', outcome: 'Draw (0-10 min)', rawMarketId: '105', rawSpecifier: 'from=1|to=10' })
  return c
}

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
for (let pg = 1; pg <= 40; pg++) {
  const res = await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr:sport:1&marketId=10,11,18,19,20,60110,105&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) for (const ev of t.events || []) {
    pageEvents++
    const fid = Number(String(ev.eventId).split(':').pop())
    if (!targetIds.has(fid)) continue
    out.set(fid, { fixtureId: fid, home: ev.homeTeamName, away: ev.awayTeamName, game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, kickoff: new Date(ev.estimateStartTime).toISOString(), cands: candidatesFor(ev) })
  }
  if (pageEvents === 0 || out.size >= targetIds.size) break
}
console.log(`Pulled ${out.size} of ${targetIds.size} target games`)

async function pool(items, worker, n = 4) {
  const res = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await worker(items[k]) } }))
  return res
}

const evaluated = await pool([...out.values()], async f => {
  if (!f.cands.length) return null
  const pair = await resolvePair(f.home, f.away)
  let lam = null
  if (pair) {
    const newest = r => Math.max(...r.map(x => new Date(x.date).getTime()))
    const ageH = (Date.now() - newest(pair.homeResults)) / 864e5, ageA = (Date.now() - newest(pair.awayResults)) / 864e5
    if (ageH <= STALE_DAYS && ageA <= STALE_DAYS) lam = estimateLambdas(pair.homeResults, pair.awayResults, f.home, f.away)
  }
  const scored = f.cands.map(c => {
    let formProb = null
    if (lam) {
      const fm = c.market === 'DC1UP' ? 'DC' : c.market
      const fp = formProbFor(fm, lam.lambdaHome, lam.lambdaAway, c.outcome.replace(/ \(1UP\)$/, ''))
      formProb = fp == null ? null : typeof fp === 'number' ? fp : (/^home/i.test(c.outcome) ? fp.pHomeWin : fp.pAwayWin)
    }
    const blend = formProb == null ? c.bookProb : 0.6 * c.bookProb + 0.4 * formProb
    return { ...c, formProb, blend, verified: formProb != null }
  })
  scored.sort((a, b) => (b.blend + rankKey(b.market)) - (a.blend + rankKey(a.market)))
  return { ...f, pick: scored[0] }
}, 4)
await closeHistorySession()

const legs = evaluated.filter(Boolean).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff)).map(p => ({ fixtureId: p.fixtureId, game: p.game, kickoff: p.kickoff, market: p.pick.market, outcome: p.pick.outcome, odds: p.pick.odds, bookProb: p.pick.bookProb, formProb: p.pick.formProb, blendProb: p.pick.blend, verified: p.pick.verified, rawMarketId: p.pick.rawMarketId, rawSpecifier: p.pick.rawSpecifier, rawOutcomeId: p.pick.rawOutcomeId }))
console.log(`${legs.length} legs picked`)
writeFileSync('slip-5leagues-all.json', JSON.stringify({ legs }, null, 2))
console.log('Wrote slip-5leagues-all.json')

/**
 * One-off: for the 24 named games, pull the FULL market board (1X2, DC, DNB, O/U at every
 * offered line, team totals, BTTS, DC1UP, Draw 0-10min) and use the recency-weighted Poisson
 * form model (not book price) to decide which outcome is genuinely well-supported by recent
 * results — then, per game, take the highest-odds outcome that the model still rates as a
 * real read (blend >= SANITY floor), explicitly favoring higher lines (e.g. Over 2.5 over
 * Over 1.5) when the record supports it. No odds cap.
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { fetchTeamResultsPair, closeHistorySession } from './lib-history.mjs'
import { estimateLambdas, pHatOver, pBothScore, pMatchResult1X2 } from './lib-form-model.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MIN_ODDS = 1.02
const SANITY = 0.55 // not a target floor — just excludes picks the model itself thinks are coinflip-or-worse
const targets = JSON.parse(readFileSync('.now2pm-fixtures.json', 'utf8'))
const targetIds = new Set(targets.map(t => t.fixtureId))

function extractCandidates(ev) {
  const mk = {}
  for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (mk[m.id] ??= []).push(m) }
  const c = []
  const add = (o, x) => { if (o?.isActive === 1 && +o.odds >= MIN_ODDS) c.push({ ...x, odds: +o.odds, bookProb: +o.probability, rawOutcomeId: o.id }) }
  // 1X2
  const h2h = (mk['1'] || [])[0]
  if (h2h) for (const o of h2h.outcomes || []) {
    const side = o.id === '1' ? 'home' : o.id === '2' ? 'draw' : 'away'
    add(o, { market: '1X2', side, outcome: side === 'home' ? ev.homeTeamName + ' to win' : side === 'away' ? ev.awayTeamName + ' to win' : 'Draw', rawMarketId: '1', rawSpecifier: '' })
  }
  // O/U at every offered line
  for (const m of mk['18'] || []) {
    const line = +m.specifier.replace('total=', '')
    const over = m.outcomes.find(x => /^over/i.test(x.desc))
    const under = m.outcomes.find(x => /^under/i.test(x.desc))
    if (over) add(over, { market: 'OU', side: 'over', line, outcome: `Over ${line}`, rawMarketId: '18', rawSpecifier: m.specifier })
    if (under) add(under, { market: 'OU', side: 'under', line, outcome: `Under ${line}`, rawMarketId: '18', rawSpecifier: m.specifier })
  }
  // DC
  const dc = (mk['10'] || [])[0]
  if (dc) for (const o of dc.outcomes || []) add(o, { market: 'DC', outcome: o.desc, rawMarketId: '10', rawSpecifier: '' })
  // DNB
  const dnb = (mk['11'] || [])[0]
  if (dnb) for (const o of dnb.outcomes || []) add(o, { market: 'DNB', side: /^home/i.test(o.desc) ? 'home' : 'away', outcome: `${/^home/i.test(o.desc) ? ev.homeTeamName : ev.awayTeamName} (DNB)`, rawMarketId: '11', rawSpecifier: '' })
  // BTTS
  const btts = (mk['29'] || [])[0]
  if (btts) for (const o of btts.outcomes || []) add(o, { market: 'BTTS', side: /yes/i.test(o.desc) ? 'yes' : 'no', outcome: `BTTS ${o.desc}`, rawMarketId: '29', rawSpecifier: '' })
  // team totals
  const h19 = (mk['19'] || []).find(m => m.specifier === 'total=0.5')
  if (h19) { const o = h19.outcomes.find(x => /^over/i.test(x.desc)); if (o) add(o, { market: 'HOU05', outcome: ev.homeTeamName + ' Over 0.5', rawMarketId: '19', rawSpecifier: 'total=0.5' }) }
  const a20 = (mk['20'] || []).find(m => m.specifier === 'total=0.5')
  if (a20) { const o = a20.outcomes.find(x => /^over/i.test(x.desc)); if (o) add(o, { market: 'AOU05', outcome: ev.awayTeamName + ' Over 0.5', rawMarketId: '20', rawSpecifier: 'total=0.5' }) }
  // DC1UP
  const d1 = (mk['60110'] || [])[0]
  if (d1) for (const o of d1.outcomes || []) add(o, { market: 'DC1UP', outcome: o.desc + ' (1UP)', rawMarketId: '60110', rawSpecifier: '' })
  // Draw 0-10
  const d10 = (mk['105'] || []).find(m => m.specifier === 'from=1|to=10')
  if (d10) { const o = d10.outcomes.find(x => /draw/i.test(x.desc)); if (o) add(o, { market: 'DRAW10', outcome: 'Draw (0-10 min)', rawMarketId: '105', rawSpecifier: 'from=1|to=10' }) }
  return c
}

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
  const n = Math.max(hv.length, av.length)
  const tried = new Set()
  for (let i = 0; i < n && (!H || !A); i++) {
    const h = hv[Math.min(i, hv.length - 1)], a = av[Math.min(i, av.length - 1)]
    if (tried.has(h + '|' + a)) continue
    tried.add(h + '|' + a)
    const p = await fetchTeamResultsPair(h, a)
    if (!p) continue
    if (!H && p.homeResults.length >= 3) H = p.homeResults
    if (!A && p.awayResults.length >= 3) A = p.awayResults
  }
  return H && A ? { homeResults: H, awayResults: A } : null
}

const out = new Map()
for (let pg = 1; pg <= 70; pg++) {
  const res = await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr:sport:1&marketId=1,10,11,18,19,20,29,60110,105&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) for (const ev of t.events || []) {
    pageEvents++
    const fid = Number(String(ev.eventId).split(':').pop())
    if (!targetIds.has(fid)) continue
    out.set(fid, { fixtureId: fid, home: ev.homeTeamName, away: ev.awayTeamName, game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, kickoff: new Date(ev.estimateStartTime).toISOString(), cands: extractCandidates(ev) })
  }
  if (pageEvents === 0 || out.size >= targetIds.size) break
}
console.log(`Pulled ${out.size} of ${targetIds.size} target games`)

async function pool(items, worker, n = 4) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await worker(items[k]) } }))
  return out
}

const evaluated = await pool([...out.values()], async f => {
  let lam = null
  const pair = await resolvePair(f.home, f.away)
  if (pair) {
    const newest = r => Math.max(...r.map(x => new Date(x.date).getTime()))
    const ageH = (Date.now() - newest(pair.homeResults)) / 864e5, ageA = (Date.now() - newest(pair.awayResults)) / 864e5
    if (ageH <= 45 && ageA <= 45) lam = estimateLambdas(pair.homeResults, pair.awayResults, f.home, f.away)
  }
  const scored = f.cands.map(c => {
    let formProb = null
    if (lam) {
      const { lambdaHome: lh, lambdaAway: la } = lam
      if (c.market === 'OU') formProb = c.side === 'over' ? pHatOver(lh, la, c.line) : 1 - pHatOver(lh, la, c.line)
      else if (c.market === 'BTTS') formProb = c.side === 'yes' ? pBothScore(lh, la) : 1 - pBothScore(lh, la)
      else if (c.market === '1X2') { const r = pMatchResult1X2(lh, la); formProb = c.side === 'home' ? r.pHome : c.side === 'away' ? r.pAway : r.pDraw }
      else if (c.market === 'DNB') { const r = pMatchResult1X2(lh, la); const base = r.pHome + r.pAway; formProb = base > 0 ? (c.side === 'home' ? r.pHome / base : r.pAway / base) : null }
      else if (c.market === 'DC' || c.market === 'DC1UP') {
        const r = pMatchResult1X2(lh, la)
        if (/home or draw/i.test(c.outcome)) formProb = r.pHome + r.pDraw
        else if (/draw or away/i.test(c.outcome)) formProb = r.pDraw + r.pAway
        else if (/home or away/i.test(c.outcome)) formProb = r.pHome + r.pAway
      }
      else if (c.market === 'HOU05') formProb = 1 - Math.exp(-lh)
      else if (c.market === 'AOU05') formProb = 1 - Math.exp(-la)
      else if (c.market === 'DRAW10') formProb = null // no sub-10-minute form signal — leave book-only
    }
    const blend = formProb == null ? c.bookProb : 0.6 * c.bookProb + 0.4 * formProb
    return { ...c, formProb, blend, verified: formProb != null }
  })
  const nonBtts = scored.filter(c => c.market !== 'BTTS')
  const eligible = nonBtts.filter(c => c.blend >= SANITY)
  const pool2 = eligible.length ? eligible : nonBtts
  pool2.sort((a, b) => b.odds - a.odds)
  return { ...f, pick: pool2[0], allScored: scored }
}, 4)
await closeHistorySession()

evaluated.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
const legs = evaluated.map(p => ({ fixtureId: p.fixtureId, game: p.game, kickoff: p.kickoff, market: p.pick.market, outcome: p.pick.outcome, odds: p.pick.odds, bookProb: p.pick.bookProb, formProb: p.pick.formProb, blendProb: p.pick.blend, verified: p.pick.verified, rawMarketId: p.pick.rawMarketId, rawSpecifier: p.pick.rawSpecifier, rawOutcomeId: p.pick.rawOutcomeId }))
const combinedOdds = legs.reduce((pr, l) => pr * l.odds, 1)
const combinedProb = legs.reduce((pr, l) => pr * l.blendProb, 1)
console.log(`\n${legs.length} legs, combined odds ${combinedOdds.toFixed(2)}x, combined blended probability ${(combinedProb * 100).toFixed(4)}%`)
for (const l of legs) console.log(`${l.kickoff.slice(5, 16)}Z ${l.game} -> ${l.market} ${l.outcome} @ ${l.odds}  book ${(l.bookProb * 100).toFixed(0)}%${l.verified ? ' form ' + (l.formProb * 100).toFixed(0) + '% blend ' + (l.blendProb * 100).toFixed(0) + '%' : ' [book only, no form signal]'}`)
writeFileSync('slip-recordbased.json', JSON.stringify({ legs, combinedOdds, combinedBlendProbability: combinedProb }, null, 2))
console.log('Wrote slip-recordbased.json')
writeFileSync('.recordbased-allcands.json', JSON.stringify(evaluated.map(f => ({ fixtureId: f.fixtureId, game: f.game, kickoff: f.kickoff, allScored: f.allScored.filter(c => c.market !== 'BTTS') })), null, 2))

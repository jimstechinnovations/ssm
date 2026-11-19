/**
 * scripts/cook-slip.mjs — reusable slip cooker.
 *
 * Method (confirmed working 2026-08-29): pick the single safest (highest true-probability,
 * >=1.20 odds) market per game, prefer legs that kick off in the same window so the slip
 * finishes together, and only add extra games if the named teams don't already reach the
 * target combined odds.
 *
 * Usage:
 *   node scripts/cook-slip.mjs --teams="Juventus,Angers,Brest,Lorient,Lyon,Sevilla" --target=5
 *   node scripts/cook-slip.mjs --target=5 --hours=8          (no teams: best games overall)
 *
 * Flags:
 *   --teams="A,B,C"     comma-separated team names to anchor the slip on (optional)
 *   --target=5          target combined odds (default 5)
 *   --hours=12          how many hours ahead to search (default 12)
 *   --toISO=            explicit window end (overrides --hours)
 *   --maxFillers=2       cap on extra games added beyond the named teams (default 2)
 *   --out=slip.json      output file (default cooked-slip.json)
 */
import { writeFileSync } from 'node:fs'

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const MARKETS = '1,10,11,16,18'
const MIN_ODDS = 1.20

const arg = (name, fallback = null) => {
  const found = process.argv.find(x => x.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const TEAMS = (arg('teams', '') || '').split(',').map(s => s.trim()).filter(Boolean)
const TARGET = Number(arg('target', '5'))
const MAX_FILLERS = Number(arg('maxFillers', '2'))
const OUT = arg('out', 'cooked-slip.json')
const NO_UNDER = process.argv.includes('--noUnder')
const FROM = Date.now()
const TO = arg('toISO') ? new Date(arg('toISO')).getTime() : Date.now() + Number(arg('hours', '12')) * 3600 * 1000

const devig = (a, b) => { const ia = 1 / a, ib = 1 / b, s = ia + ib; return { pA: ia / s, pB: ib / s, margin: s - 1 } }
const devig3 = (h, d, a) => { const ih = 1 / h, id = 1 / d, ia = 1 / a, s = ih + id + ia; return { pH: ih / s, pD: id / s, pA: ia / s, margin: s - 1 } }
function marketsById(ev) { const out = {}; for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (out[m.id] ??= []).push(m) }; return out }

function bestCandidates(ev) {
  const mk = marketsById(ev)
  const candidates = []
  const ou45 = (mk['18'] || []).find(m => m.specifier === 'total=4.5')
  if (ou45) {
    const u = ou45.outcomes.find(o => /^under/i.test(o.desc)), o = ou45.outcomes.find(x => /^over/i.test(x.desc))
    if (u && o && !NO_UNDER) { const { pA, margin } = devig(+u.odds, +o.odds); if (+u.odds >= MIN_ODDS) candidates.push({ market: 'U45', outcome: 'Under 4.5', odds: +u.odds, trueProb: pA, margin }) }
  }
  const ou15 = (mk['18'] || []).find(m => m.specifier === 'total=1.5')
  if (ou15) {
    const u = ou15.outcomes.find(o => /^under/i.test(o.desc)), o = ou15.outcomes.find(x => /^over/i.test(x.desc))
    if (u && o) { const { pB, margin } = devig(+u.odds, +o.odds); if (+o.odds >= MIN_ODDS) candidates.push({ market: 'O15', outcome: 'Over 1.5', odds: +o.odds, trueProb: pB, margin }) }
  }
  const dc = (mk['10'] || [])[0]
  if (dc) {
    const opts = (dc.outcomes || []).map(o => ({ desc: o.desc, odds: +o.odds })).filter(o => o.odds > 1)
    if (opts.length === 3) {
      const impliedSum = opts.reduce((s, o) => s + 1 / o.odds, 0)
      const cheapest = [...opts].sort((a, b) => a.odds - b.odds)[0]
      if (cheapest.odds >= MIN_ODDS) candidates.push({ market: 'DC', outcome: cheapest.desc, odds: cheapest.odds, trueProb: (1 / cheapest.odds) / impliedSum, margin: impliedSum - 1 })
    }
  }
  const dnb = (mk['11'] || [])[0]
  if (dnb) {
    const home = dnb.outcomes.find(o => /^home/i.test(o.desc)), away = dnb.outcomes.find(o => /^away/i.test(o.desc))
    if (home && away) {
      const { pA, pB, margin } = devig(+home.odds, +away.odds)
      const fav = +home.odds <= +away.odds ? { desc: 'Home (DNB)', odds: +home.odds, p: pA } : { desc: 'Away (DNB)', odds: +away.odds, p: pB }
      if (fav.odds >= MIN_ODDS) candidates.push({ market: 'DNB', outcome: fav.desc, odds: fav.odds, trueProb: fav.p, margin })
    }
  }
  const x12 = (mk['1'] || [])[0]
  if (x12) {
    const home = x12.outcomes.find(o => /^home/i.test(o.desc)), draw = x12.outcomes.find(o => /^draw/i.test(o.desc)), away = x12.outcomes.find(o => /^away/i.test(o.desc))
    if (home && draw && away) {
      const { pH, pA, margin } = devig3(+home.odds, +draw.odds, +away.odds)
      const fav = pH >= pA ? { desc: `Home [${ev.homeTeamName}]`, odds: +home.odds, p: pH } : { desc: `Away [${ev.awayTeamName}]`, odds: +away.odds, p: pA }
      if (fav.odds >= MIN_ODDS) candidates.push({ market: '1X2', outcome: fav.desc, odds: fav.odds, trueProb: fav.p, margin })
    }
  }
  const hcpLines = mk['16'] || []
  if (x12 && hcpLines.length) {
    const home = x12.outcomes.find(o => /^home/i.test(o.desc)), away = x12.outcomes.find(o => /^away/i.test(o.desc))
    if (home && away) {
      const favIsHome = +home.odds <= +away.odds
      const half = hcpLines.find(m => m.specifier === (favIsHome ? 'hcp=-0.5' : 'hcp=0.5'))
      if (half) {
        const favDesc = favIsHome ? /^home/i : /^away/i
        const favOut = half.outcomes.find(o => favDesc.test(o.desc) && /\(-0\.5\)/.test(o.desc))
        const dogOut = half.outcomes.find(o => !favDesc.test(o.desc))
        if (favOut && dogOut) {
          const { pA, margin } = devig(+favOut.odds, +dogOut.odds)
          if (+favOut.odds >= MIN_ODDS) candidates.push({ market: 'HCP', outcome: `${favOut.desc} [${favIsHome ? ev.homeTeamName : ev.awayTeamName}]`, odds: +favOut.odds, trueProb: pA, margin })
        }
      }
    }
  }
  return candidates.sort((a, b) => b.trueProb - a.trueProb)
}

const isSimulated = (t, ev) => /simulat/i.test(t.category?.name || '') || /\bsrl\b/i.test(ev.homeTeamName || '') || /\bsrl\b/i.test(ev.awayTeamName || '')

console.log(`Window: ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()}`)
if (TEAMS.length) console.log(`Anchor teams: ${TEAMS.join(', ')}`)
console.log(`Target combined odds: ${TARGET}x`)

const all = []
for (let pg = 1; pg <= 20; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=${MARKETS}&pageSize=100&pageNum=${pg}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) {
    for (const ev of t.events || []) {
      pageEvents++
      if (isSimulated(t, ev)) continue
      if (ev.estimateStartTime < FROM || ev.estimateStartTime > TO) continue
      const candidates = bestCandidates(ev)
      if (!candidates.length) continue
      all.push({
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        league: t.name,
        kickoff: new Date(ev.estimateStartTime).toISOString(),
        kickoffMs: ev.estimateStartTime,
        best: candidates[0],
      })
    }
  }
  if (pageEvents === 0 && pg > 8) break
}
all.sort((a, b) => a.kickoffMs - b.kickoffMs)

let mandatory = []
let pool = all
if (TEAMS.length) {
  const isTeamMatch = row => TEAMS.some(name => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(row.game))
  mandatory = all.filter(isTeamMatch)
  pool = all.filter(row => !isTeamMatch(row))
  const missing = TEAMS.filter(name => !mandatory.some(r => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(r.game)))
  if (missing.length) console.log(`No fixture found in window for: ${missing.join(', ')}`)
} else {
  // no teams named: rank everyone by probability, mandatory starts empty, filler pool = all
  pool = all
}

pool = [...pool].sort((a, b) => b.best.trueProb - a.best.trueProb)

const legs = [...mandatory]
let product = legs.reduce((p, l) => p * l.best.odds, 1)

// restrict fillers to roughly the same kickoff window as the mandatory legs when there are any
let fillerCandidates = pool
if (mandatory.length) {
  const kmin = Math.min(...mandatory.map(l => l.kickoffMs)) - 20 * 60 * 1000
  const kmax = Math.max(...mandatory.map(l => l.kickoffMs)) + 60 * 60 * 1000
  fillerCandidates = pool.filter(r => r.kickoffMs >= kmin && r.kickoffMs <= kmax)
}

let added = 0
for (const row of fillerCandidates) {
  if (product >= TARGET) break
  if (added >= MAX_FILLERS) break
  legs.push(row)
  product *= row.best.odds
  added++
}
// if still short and no team anchors, keep pulling from the whole pool regardless of window
if (!mandatory.length) {
  for (const row of pool) {
    if (product >= TARGET) break
    if (legs.includes(row)) continue
    legs.push(row)
    product *= row.best.odds
  }
}

legs.sort((a, b) => a.kickoffMs - b.kickoffMs)

console.log(`\nCooked slip — ${legs.length} legs, combined odds ${product.toFixed(2)}x`)
for (const l of legs) {
  const tag = mandatory.includes(l) ? '(named)' : '(filler)'
  console.log(`[${l.league}] ${l.kickoff}  ${l.game} ${tag} -> ${l.best.market} ${l.best.outcome} @ ${l.best.odds} (${(l.best.trueProb * 100).toFixed(1)}%)`)
}

const ticket = {
  generatedAt: new Date().toISOString(),
  window: { fromISO: new Date(FROM).toISOString(), toISO: new Date(TO).toISOString() },
  anchorTeams: TEAMS,
  target: TARGET,
  combinedOdds: product,
  note: 'Preview only. No stake entered and no bet placed.',
  legs: legs.map(l => ({
    fixtureId: l.fixtureId,
    game: l.game,
    league: l.league,
    kickoff: l.kickoff,
    market: l.best.market,
    outcome: l.best.outcome,
    odds: l.best.odds,
    trueProb: l.best.trueProb,
    named: mandatory.includes(l),
  })),
}
writeFileSync(OUT, JSON.stringify(ticket, null, 2))
console.log(`\nWrote ${OUT}`)

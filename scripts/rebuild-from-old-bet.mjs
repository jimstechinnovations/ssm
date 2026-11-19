/**
 * scripts/rebuild-from-old-bet.mjs — take the fixture list from an OLD placed bet (resolved via its
 * own public booking code) and re-pick each still-upcoming fixture's best leg using the current
 * full 9-market scheme (scripts/build-multimarket-pedla-book.mjs's bestLeg, kept in sync here).
 * Already-played fixtures from the old bet are dropped (can't be rebet) and reported separately.
 *
 * Run: node scripts/rebuild-from-old-bet.mjs <oldSelectionsFile> [stake=500] [out=rebuilt-slip.json]
 */
import { writeFileSync } from 'node:fs'

const selFile = process.argv[2] || 'old-bet-selections.json'
const STAKE = Number(process.argv[3] || 500)
const OUT = process.argv[4] || 'rebuilt-slip.json'
const minOddsArg = process.argv.find(x => x.startsWith('--minOdds='))
const MIN_ODDS = minOddsArg ? Number(minOddsArg.split('=')[1]) : 1.05
const maxLegsArg = process.argv.find(x => x.startsWith('--maxLegs='))
const MAX_LEGS = maxLegsArg ? Number(maxLegsArg.split('=')[1]) : Infinity

const oldSelections = JSON.parse(await (await import('node:fs/promises')).readFile(selFile, 'utf8'))
const fixtureIds = [...new Set(oldSelections.map(s => s.eventId))]

const devig = (a, b) => { const ia = 1 / a, ib = 1 / b, s = ia + ib; return { pA: ia / s, pB: ib / s, margin: s - 1 } }
const devig3 = (h, d, a) => { const ih = 1 / h, id = 1 / d, ia = 1 / a, s = ih + id + ia; return { pH: ih / s, pD: id / s, pA: ia / s, margin: s - 1 } }
function marketsById(ev) { const out = {}; for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (out[m.id] ??= []).push(m) }; return out }

function bestLeg(ev) {
  const mk = marketsById(ev)
  const candidates = []

  const ouLines = (mk['18'] || []).filter(m => /^total=/.test(m.specifier || ''))
  for (const line of ouLines) {
    const u = line.outcomes.find(o => /^under/i.test(o.desc)), o = line.outcomes.find(x => /^over/i.test(x.desc))
    if (!u || !o) continue
    const { pA, pB, margin } = devig(+u.odds, +o.odds)
    const lineNum = line.specifier.split('=')[1]
    const pick = pA >= pB ? { desc: `Under ${lineNum}`, odds: +u.odds, p: pA } : { desc: `Over ${lineNum}`, odds: +o.odds, p: pB }
    if (pick.odds >= MIN_ODDS) candidates.push({ market: `OU${lineNum}`, outcome: pick.desc, odds: pick.odds, trueProb: pick.p, margin })
  }
  for (const [mid, prefix] of [['19', 'HOU'], ['20', 'AOU']]) {
    const lines = (mk[mid] || []).filter(m => /^total=/.test(m.specifier || ''))
    for (const line of lines) {
      const u = line.outcomes.find(o => /^under/i.test(o.desc)), o = line.outcomes.find(x => /^over/i.test(x.desc))
      if (!u || !o) continue
      const { pA, pB, margin } = devig(+u.odds, +o.odds)
      const lineNum = line.specifier.split('=')[1]
      const pick = pA >= pB ? { desc: `Under ${lineNum}`, odds: +u.odds, p: pA } : { desc: `Over ${lineNum}`, odds: +o.odds, p: pB }
      if (pick.odds >= MIN_ODDS) candidates.push({ market: `${prefix}${lineNum}`, outcome: pick.desc, odds: pick.odds, trueProb: pick.p, margin })
    }
  }
  const margin1 = (mk['15'] || [])[0]
  if (margin1) {
    const allOpts = (margin1.outcomes || []).filter(o => +o.odds > 1)
    const impliedSum = allOpts.reduce((s, o) => s + 1 / +o.odds, 0)
    const homeBy1 = margin1.outcomes.find(o => /^home by 1$/i.test(o.desc)), awayBy1 = margin1.outcomes.find(o => /^away by 1$/i.test(o.desc))
    if (homeBy1 && awayBy1 && impliedSum > 0) {
      const pHome = (1 / +homeBy1.odds) / impliedSum, pAway = (1 / +awayBy1.odds) / impliedSum
      const pick = pHome >= pAway
        ? { desc: `Home by 1 [${ev.homeTeamName}]`, odds: +homeBy1.odds, p: pHome, id: homeBy1.id }
        : { desc: `Away by 1 [${ev.awayTeamName}]`, odds: +awayBy1.odds, p: pAway, id: awayBy1.id }
      if (pick.odds >= MIN_ODDS) candidates.push({ market: 'MARGIN1', outcome: pick.desc, odds: pick.odds, trueProb: pick.p, margin: impliedSum - 1, rawMarketId: '15', rawSpecifier: margin1.specifier, rawOutcomeId: pick.id })
    }
  }
  const btts = (mk['29'] || [])[0]
  if (btts) {
    const yes = btts.outcomes.find(o => /^yes/i.test(o.desc)), no = btts.outcomes.find(o => /^no/i.test(o.desc))
    if (yes && no) {
      const { pA, pB, margin } = devig(+yes.odds, +no.odds)
      const pick = pA >= pB ? { desc: 'Yes', odds: +yes.odds, p: pA } : { desc: 'No', odds: +no.odds, p: pB }
      if (pick.odds >= MIN_ODDS) candidates.push({ market: 'BTTS', outcome: pick.desc, odds: pick.odds, trueProb: pick.p, margin })
    }
  }
  const goalRange = (mk['25'] || [])[0]
  if (goalRange) {
    const opts = (goalRange.outcomes || []).map(o => ({ id: o.id, desc: o.desc, odds: +o.odds })).filter(o => o.odds > 1)
    if (opts.length >= 2) {
      const impliedSum = opts.reduce((s, o) => s + 1 / o.odds, 0)
      const cheapest = [...opts].sort((a, b) => a.odds - b.odds)[0]
      const p = (1 / cheapest.odds) / impliedSum
      if (cheapest.odds >= MIN_ODDS) candidates.push({ market: 'GOALRANGE', outcome: `Goals ${cheapest.desc}`, odds: cheapest.odds, trueProb: p, margin: impliedSum - 1, rawMarketId: '25', rawSpecifier: goalRange.specifier, rawOutcomeId: cheapest.id })
    }
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
      const { pH, pA } = devig3(+home.odds, +draw.odds, +away.odds)
      const fav = pH >= pA ? { desc: `Home [${ev.homeTeamName}]`, odds: +home.odds, p: pH } : { desc: `Away [${ev.awayTeamName}]`, odds: +away.odds, p: pA }
      if (fav.odds >= MIN_ODDS) candidates.push({ market: '1X2', outcome: fav.desc, odds: fav.odds, trueProb: fav.p, margin: (1 / +home.odds + 1 / +draw.odds + 1 / +away.odds) - 1 })
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

  if (!candidates.length) return null
  candidates.sort((a, b) => b.trueProb - a.trueProb)
  return candidates[0]
}

console.log(`resolving ${fixtureIds.length} fixtures from the old bet...`)
const rows = []
const dropped = []
for (const eventId of fixtureIds) {
  // productId=3 (pre-match) returns full markets for not-yet-started fixtures; productId=1 only
  // returns markets once a match has gone live/finished — try 3 first, fall back to 1.
  let ev = null
  for (const productId of [3, 1]) {
    const url = `https://www.sportybet.com/api/ng/factsCenter/event?eventId=${eventId}&productId=${productId}&marketId=1,10,11,15,16,18,19,20,25,29`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
    const json = await res.json()
    if (json.bizCode === 10000 && json.data?.markets?.length) { ev = json.data; break }
    if (json.bizCode === 10000 && json.data) ev = json.data // keep as fallback (e.g. Ended match, 0 markets but valid status)
  }
  if (!ev) { dropped.push({ eventId, reason: 'fetch failed' }); continue }
  if (!/not start/i.test(ev.matchStatus || '')) { dropped.push({ eventId, reason: `${ev.matchStatus} (${ev.homeTeamName} vs ${ev.awayTeamName})` }); continue }
  const picked = bestLeg(ev)
  if (!picked) { dropped.push({ eventId, reason: `no qualifying candidate (${ev.homeTeamName} vs ${ev.awayTeamName})` }); continue }
  rows.push({ fixtureId: Number(eventId.split(':').pop()), game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, league: ev.sport?.category?.tournament?.name || '', picked })
}

console.log(`\n${rows.length} still-upcoming fixtures rebuilt, ${dropped.length} dropped:`)
for (const d of dropped) console.log(`  DROPPED ${d.eventId} — ${d.reason}`)

// keep only the strongest MAX_LEGS picks (highest trueProb first) — same "safest first" logic the
// main builders use, so a --maxLegs cap actually gives you the best subset, not an arbitrary slice.
rows.sort((a, b) => b.picked.trueProb - a.picked.trueProb)
if (rows.length > MAX_LEGS) rows.length = MAX_LEGS

console.log(`\n===== REBUILT (new market set) — ${rows.length} legs =====\n`)
for (const r of rows) console.log(`[${r.picked.market}] ${r.game} — ${r.picked.outcome} @ ${r.picked.odds} (${(r.picked.trueProb * 100).toFixed(1)}%)`)

const combinedOdds = rows.reduce((p, r) => p * r.picked.odds, 1)
const trueProb = rows.reduce((p, r) => p * r.picked.trueProb, 1)
const legs = rows.map(r => ({ fixtureId: r.fixtureId, game: r.game, league: r.league, market: r.picked.market, outcome: r.picked.outcome, odds: r.picked.odds, ...(r.picked.rawMarketId ? { rawMarketId: r.picked.rawMarketId, rawSpecifier: r.picked.rawSpecifier, rawOutcomeId: r.picked.rawOutcomeId } : {}) }))
const slip = { stake: STAKE, legs, combinedOdds, trueProb, potentialPayout: Math.round(combinedOdds * STAKE) }
writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), slips: [slip] }, null, 1))

console.log(`\n===== ${OUT}: ${rows.length} legs, combined odds ${combinedOdds.toFixed(2)}, trueProb ${(trueProb * 100).toFixed(3)}%, payout ₦${slip.potentialPayout} =====`)

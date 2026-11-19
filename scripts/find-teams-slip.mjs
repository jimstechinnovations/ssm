/**
 * scripts/find-teams-slip.mjs — locate tonight's fixtures for a specific list of teams,
 * print each fixture's best market candidates (via the same devig logic as
 * build-top5-league-ticket.mjs), and optionally look for 1-2 extra fixtures kicking off
 * in the same window to round out a target combined-odds slip.
 *
 * Run: node scripts/find-teams-slip.mjs --teams="Juventus,Angers,Brest,Lorient,Lyon,Sevilla" --toISO=2026-08-30T02:00:00Z
 */
const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const MARKETS = '1,10,11,16,18'
const MIN_ODDS = 1.20

const arg = (name, fallback = null) => {
  const found = process.argv.find(x => x.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const TEAMS = (arg('teams', '') || '').split(',').map(s => s.trim()).filter(Boolean)
const FROM = Date.now()
const TO = new Date(arg('toISO', new Date(Date.now() + 12 * 3600 * 1000).toISOString())).getTime()

const devig = (a, b) => { const ia = 1 / a, ib = 1 / b, s = ia + ib; return { pA: ia / s, pB: ib / s, margin: s - 1 } }
const devig3 = (h, d, a) => { const ih = 1 / h, id = 1 / d, ia = 1 / a, s = ih + id + ia; return { pH: ih / s, pD: id / s, pA: ia / s, margin: s - 1 } }
function marketsById(ev) { const out = {}; for (const m of ev.markets || []) { if (m.status !== undefined && m.status !== 0) continue; (out[m.id] ??= []).push(m) }; return out }

function bestCandidates(ev) {
  const mk = marketsById(ev)
  const candidates = []
  const ou45 = (mk['18'] || []).find(m => m.specifier === 'total=4.5')
  if (ou45) {
    const u = ou45.outcomes.find(o => /^under/i.test(o.desc)), o = ou45.outcomes.find(x => /^over/i.test(x.desc))
    if (u && o) { const { pA, margin } = devig(+u.odds, +o.odds); if (+u.odds >= MIN_ODDS) candidates.push({ market: 'U45', outcome: 'Under 4.5', odds: +u.odds, trueProb: pA, margin }) }
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

const matched = []
const window = []
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
      const row = {
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        league: t.name,
        country: t.categoryName || t.category?.name || '',
        kickoff: new Date(ev.estimateStartTime).toISOString(),
        candidates: bestCandidates(ev),
      }
      const isTeamMatch = TEAMS.some(name => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(row.game))
      if (isTeamMatch) matched.push(row)
      else if (row.candidates.length) window.push(row)
    }
  }
  if (pageEvents === 0 && pg > 8) break
}

matched.sort((a, b) => a.kickoff.localeCompare(b.kickoff))
window.sort((a, b) => a.kickoff.localeCompare(b.kickoff))

console.log(`\n=== Matched team fixtures (${matched.length}) ===`)
for (const r of matched) {
  console.log(`\n[${r.league}] ${r.kickoff}  ${r.game}  (fixtureId ${r.fixtureId})`)
  for (const c of r.candidates.slice(0, 3)) console.log(`   ${c.market} ${c.outcome} @ ${c.odds} (trueProb ${(c.trueProb * 100).toFixed(1)}%)`)
}

console.log(`\n=== Other fixtures in window, sorted by kickoff (first 40 of ${window.length}) ===`)
for (const r of window.slice(0, 40)) {
  const top = r.candidates[0]
  console.log(`[${r.league}] ${r.kickoff}  ${r.game}  (fixtureId ${r.fixtureId})  -> ${top ? `${top.market} ${top.outcome} @ ${top.odds}` : 'no candidate'}`)
}

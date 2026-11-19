/**
 * scripts/build-test-multimarket-slip.mjs — TEST/PREVIEW ONLY. Builds one sample slip by picking,
 * per fixture, the single BEST candidate leg out of five markets:
 *
 *   U45  Under 4.5      (existing PEDLA anchor)
 *   O15  Over 1.5        (mirror-safe high side — most matches have 2+ goals)
 *   DC   Double Chance   (cheapest of the three 2-outcome-covering combos)
 *   DNB  Draw No Bet     (the favourite side — lower odds of Home/Away)
 *   HCP  Handicap -0.5   (the favourite team, "win outright, no draw" — favourite decided by
 *                         comparing 1X2 Home vs Away odds: LOWER odds = stronger team, since odds
 *                         are inversely proportional to implied probability)
 *
 * "Best" = highest de-vigged true probability among candidates that still clear >=1.20 odds (the
 * same reliability floor the existing engine uses so a leg is never too short to matter). This is
 * a STRUCTURE preview, same honesty stance as the rest of PEDLA: every leg is still -vig, nothing
 * here creates edge.
 *
 * HISTORY CHECK — advisory display only, never changes the pick (matches lib/pedlas/enrich.ts's
 * stance: history has no measured edge over the book — pedlas_v2.md §1a). When the top-2 candidates
 * for a fixture are within CLOSE_MARGIN of each other's true probability, we fetch each team's last
 * results from apifootball (live network call, real data, same source lib/football-history/apifootball.ts
 * uses) and print their recent record/goals alongside the pick — so a human can see there WAS a close
 * call and what the history says, without the algorithm silently swapping markets on it.
 *
 * Run: node scripts/build-test-multimarket-slip.mjs [legs=8] [stake=100]
 */
const N = Number(process.argv[2] || 8)
const STAKE = Number(process.argv[3] || 100)

const BASE = 'https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents'
const MARKETS = '1,10,11,16,18' // 1X2, Double Chance, Draw No Bet, Handicap, Over/Under
const MIN_ODDS = 1.20 // reliability floor (matches MIN_DOMINANT_ODDS in lib/pedlas/market-select.ts)
const CLOSE_MARGIN = 0.05 // top-2 candidates within 5 points of true probability = "close call"

const APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY?.trim()
const APIFOOTBALL_BASE = (process.env.APIFOOTBALL_URL?.trim() || 'https://apiv3.apifootball.com')
if (!APIFOOTBALL_KEY) {
  for (const line of (await import('node:fs')).readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const APIFOOTBALL_KEY_RESOLVED = process.env.APIFOOTBALL_KEY?.trim()

/** Recency-weighted record from apifootball's last-10-results shape (same math as lib/football-history). */
function summarizeForm(results, team) {
  const sorted = [...(results || [])].sort((a, b) => (b.match_date ?? '').localeCompare(a.match_date ?? ''))
  let w = 0, l = 0, d = 0, gf = 0, ga = 0, n = 0
  for (const r of sorted.slice(0, 5)) {
    const hg = Number(r.match_hometeam_score), ag = Number(r.match_awayteam_score)
    if (Number.isNaN(hg) || Number.isNaN(ag)) continue
    const isHome = (r.match_hometeam_name || '').toLowerCase().includes(team.toLowerCase().split(' ')[0])
    const scored = isHome ? hg : ag, conceded = isHome ? ag : hg
    gf += scored; ga += conceded; n++
    if (scored > conceded) w++; else if (scored < conceded) l++; else d++
  }
  return n ? { w, d, l, n, gfAvg: +(gf / n).toFixed(2), gaAvg: +(ga / n).toFixed(2) } : null
}

/** Live apifootball H2H call — last results for both teams. Returns null if no key or call fails. */
async function fetchHistoryNote(home, away) {
  if (!APIFOOTBALL_KEY_RESOLVED) return null
  const url = `${APIFOOTBALL_BASE}/?action=get_H2H&firstTeam=${encodeURIComponent(home)}&secondTeam=${encodeURIComponent(away)}&APIkey=${APIFOOTBALL_KEY_RESOLVED}`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer))
    if (!res.ok) return null
    const j = await res.json().catch(() => null)
    if (!j || typeof j !== 'object') return null
    const hf = summarizeForm(j.firstTeam_lastResults, home)
    const af = summarizeForm(j.secondTeam_lastResults, away)
    if (!hf && !af) return null
    return { home: hf, away: af }
  } catch { return null }
}

const devig = (a, b) => { const ia = 1 / a, ib = 1 / b, s = ia + ib; return { pA: ia / s, pB: ib / s, margin: s - 1 } }

// status !== 0 means suspended/deactivated — same filter the real adapter uses (lib/books/sportybet.ts)
function marketsById(ev) {
  const out = {}
  for (const m of ev.markets || []) {
    if (m.status !== undefined && m.status !== 0) continue
    (out[m.id] ??= []).push(m)
  }
  return out
}

/** Best candidate leg for one fixture, or null if nothing qualifies. */
function bestLeg(ev) {
  const mk = marketsById(ev)
  const candidates = []

  // U45 — Under 4.5
  const ou = (mk['18'] || []).find(m => m.specifier === 'total=4.5')
  if (ou) {
    const u = ou.outcomes.find(o => /^under/i.test(o.desc)), o = ou.outcomes.find(x => /^over/i.test(x.desc))
    if (u && o) { const { pA, margin } = devig(+u.odds, +o.odds); if (+u.odds >= MIN_ODDS) candidates.push({ market: 'U45', outcome: 'Under 4.5', odds: +u.odds, trueProb: pA, margin }) }
  }
  // O15 — Over 1.5
  const ou15 = (mk['18'] || []).find(m => m.specifier === 'total=1.5')
  if (ou15) {
    const u = ou15.outcomes.find(o => /^under/i.test(o.desc)), o = ou15.outcomes.find(x => /^over/i.test(x.desc))
    if (u && o) { const { pB, margin } = devig(+u.odds, +o.odds); if (+o.odds >= MIN_ODDS) candidates.push({ market: 'O15', outcome: 'Over 1.5', odds: +o.odds, trueProb: pB, margin }) }
  }
  // DC — Double Chance: cheapest (most reliable) of the three covering combos
  const dc = (mk['10'] || [])[0]
  if (dc) {
    const opts = (dc.outcomes || []).map(o => ({ desc: o.desc, odds: +o.odds })).filter(o => o.odds > 1)
    if (opts.length === 3) {
      const impliedSum = opts.reduce((s, o) => s + 1 / o.odds, 0)
      const cheapest = [...opts].sort((a, b) => a.odds - b.odds)[0]
      if (cheapest.odds >= MIN_ODDS) candidates.push({ market: 'DC', outcome: cheapest.desc, odds: cheapest.odds, trueProb: (1 / cheapest.odds) / impliedSum, margin: impliedSum - 1 })
    }
  }
  // DNB — Draw No Bet: favourite side (lower odds)
  const dnb = (mk['11'] || [])[0]
  if (dnb) {
    const home = dnb.outcomes.find(o => /^home/i.test(o.desc)), away = dnb.outcomes.find(o => /^away/i.test(o.desc))
    if (home && away) {
      const { pA, pB, margin } = devig(+home.odds, +away.odds)
      const fav = +home.odds <= +away.odds ? { desc: 'Home (DNB)', odds: +home.odds, p: pA } : { desc: 'Away (DNB)', odds: +away.odds, p: pB }
      if (fav.odds >= MIN_ODDS) candidates.push({ market: 'DNB', outcome: fav.desc, odds: fav.odds, trueProb: fav.p, margin })
    }
  }
  // HCP — Handicap -0.5 for whichever team is favourite per 1X2 (lower odds = stronger team)
  const x12 = (mk['1'] || [])[0]
  const hcpLines = mk['16'] || []
  if (x12 && hcpLines.length) {
    const home = x12.outcomes.find(o => /^home/i.test(o.desc)), away = x12.outcomes.find(o => /^away/i.test(o.desc))
    if (home && away) {
      const favIsHome = +home.odds <= +away.odds
      // Home -0.5 (hcp=-0.5) favours Home; Home +0.5 (hcp=0.5) favours Away (Away reads "(-0.5)").
      // Must pick the specifier deterministically from favIsHome, NOT by array order — the feed does
      // not guarantee which of the two half-lines appears first.
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
  candidates.sort((a, b) => b.trueProb - a.trueProb) // highest true probability wins
  return { picked: candidates[0], allCandidates: candidates }
}

// ── fetch upcoming fixtures (next 24h, >=3h out so the run can't be caught by kickoff) ──
const minKick = Date.now() + 3 * 3600 * 1000
const maxKick = Date.now() + 24 * 3600 * 1000
const rows = []
for (let pg = 1; pg <= 6 && rows.length < N + 20; pg++) {
  const url = `${BASE}?sportId=${encodeURIComponent('sr:sport:1')}&marketId=${MARKETS}&pageSize=100&pageNum=${pg}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  for (const t of json.data.tournaments) {
    for (const ev of t.events || []) {
      if (ev.estimateStartTime < minKick || ev.estimateStartTime > maxKick) continue
      const r = bestLeg(ev)
      if (!r) continue
      rows.push({
        fixtureId: Number(String(ev.eventId).split(':').pop()),
        game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        league: t.name,
        kickoff: new Date(ev.estimateStartTime).toISOString(),
        ...r.picked,
        allCandidates: r.allCandidates,
      })
    }
  }
  if (json.data.tournaments.reduce((s, t) => s + (t.events?.length || 0), 0) === 0) break
}

// most reliable (highest true prob) first, take top N
rows.sort((a, b) => b.trueProb - a.trueProb)
const legs = rows.slice(0, N)

console.log(`\n===== TEST SLIP — best-of-5-markets per game (${legs.length} legs, stake ₦${STAKE}) =====\n`)
if (!APIFOOTBALL_KEY_RESOLVED) console.log('(APIFOOTBALL_KEY not set — close-call history notes will be skipped)\n')

for (const l of legs) {
  console.log(`[${l.market}] ${l.game}  (${l.league})`)
  console.log(`    picked: ${l.outcome} @ ${l.odds}  (trueProb ${(l.trueProb * 100).toFixed(1)}%, margin ${(l.margin * 100).toFixed(1)}%)`)
  console.log(`    other candidates: ${l.allCandidates.filter(c => c !== l.allCandidates.find(x => x.market === l.market)).map(c => `${c.market}=${c.odds}(${(c.trueProb * 100).toFixed(0)}%)`).join(', ') || 'none qualified'}`)

  // close-call check: is the runner-up within CLOSE_MARGIN of the pick's true probability?
  const runnerUp = l.allCandidates.find(c => c !== l.allCandidates[0]) // allCandidates is already sorted desc
  if (runnerUp && l.trueProb - runnerUp.trueProb <= CLOSE_MARGIN) {
    console.log(`    CLOSE CALL: ${l.market} (${(l.trueProb * 100).toFixed(1)}%) vs ${runnerUp.market} (${(runnerUp.trueProb * 100).toFixed(1)}%) — pulling history (advisory only)…`)
    const [home, away] = l.game.split(' vs ')
    const hist = home && away ? await fetchHistoryNote(home.trim(), away.trim()) : null
    if (hist?.home || hist?.away) {
      const fmt = (t, f) => f ? `${t}: last ${f.n} W${f.w}-D${f.d}-L${f.l}, ${f.gfAvg} GF/${f.gaAvg} GA avg` : `${t}: no recent data`
      console.log(`      history (advisory, did NOT change the pick): ${fmt(home?.trim(), hist.home)} | ${fmt(away?.trim(), hist.away)}`)
    } else {
      console.log('      history: unavailable (no API key, no match, or lookup failed) — pick stands on book price alone')
    }
  }
}
const combinedOdds = legs.reduce((p, l) => p * l.odds, 1)
console.log(`\ncombined odds: ${combinedOdds.toFixed(2)}   stake ₦${STAKE}   uncapped payout ₦${(combinedOdds * STAKE).toFixed(0)}`)
console.log(`\nSelection rule: highest de-vigged true-probability candidate wins, full stop. History above is`)
console.log(`DISPLAY ONLY for close calls — it never overrides the book price (same stance as pedlas_v2.md §1a:`)
console.log(`no measured edge from history). If you want it to actually break ties, say so and we'll change this rule.`)

// One-off override: Under 4.5 slip (normally banned — see feedback_slip_building.md).
// User explicitly asked for this, this run only, filtered to games that also qualify as Over 1.5
// (i.e. likely to see goals, not a 0-0 snoozer) as a correlated safety signal for the Under 4.5 pick.
import { writeFileSync } from 'node:fs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const toISO = process.argv[2] || '2026-10-29T22:00:00Z'
const fromMs = Date.now()
const toMs = new Date(toISO).getTime()
const MIN_O15_PROB = 0.60   // "falls in the category of over 1.5" = decent chance of 2+ goals
const MIN_U45_ODDS = 1.01

const out = new Map()
for (let pg = 1; pg <= 60; pg++) {
  const res = await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr:sport:1&marketId=18&pageSize=100&pageNum=${pg}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) for (const ev of t.events || []) {
    pageEvents++
    const koMs = new Date(ev.estimateStartTime).getTime()
    if (koMs < fromMs || koMs > toMs) continue
    const fid = Number(String(ev.eventId).split(':').pop())
    const mk = (ev.markets || []).filter(m => m.id === '18' && (m.status === undefined || m.status === 0))
    const o15m = mk.find(m => m.specifier === 'total=1.5')
    const u45m = mk.find(m => m.specifier === 'total=4.5')
    if (!o15m || !u45m) continue
    const over15 = o15m.outcomes.find(x => /^over/i.test(x.desc))
    const under45 = u45m.outcomes.find(x => /^under/i.test(x.desc))
    if (!over15 || over15.isActive !== 1) continue
    if (!under45 || under45.isActive !== 1 || +under45.odds < MIN_U45_ODDS) continue
    if (+over15.probability < MIN_O15_PROB) continue
    out.set(fid, {
      fixtureId: fid,
      game: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
      league: t.name,
      kickoff: new Date(ev.estimateStartTime).toISOString(),
      market: 'U45',
      outcome: 'Under 4.5',
      odds: +under45.odds,
      bookProb: +under45.probability,
      over15Prob: +over15.probability,
      rawMarketId: '18',
      rawSpecifier: 'total=4.5',
      rawOutcomeId: under45.id,
    })
  }
  if (pageEvents === 0) break
}

const legs = [...out.values()].sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
console.log(`${legs.length} games qualify (Over1.5 book prob >= ${MIN_O15_PROB}, Under4.5 active)`)
writeFileSync('slip-under45-only.json', JSON.stringify({ legs }, null, 2))

import { readFileSync, writeFileSync } from 'node:fs'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

function settleMarket(market, outcome, homeScore, awayScore) {
  const total = homeScore + awayScore
  switch (market) {
    case 'O15': return total > 1.5
    case 'U45': return total < 4.5
    case 'DC': {
      if (/home or draw/i.test(outcome)) return homeScore >= awayScore
      if (/draw or away/i.test(outcome)) return awayScore >= homeScore
      if (/home or away/i.test(outcome)) return homeScore !== awayScore
      return null
    }
    case 'DC1UP': {
      if (/home or draw/i.test(outcome)) return homeScore >= awayScore
      if (/draw or away/i.test(outcome)) return awayScore >= homeScore
      return null
    }
    case 'HOU05': return homeScore > 0.5
    case 'AOU05': return awayScore > 0.5
    default: return null
  }
}

const files = ['slip-big-1final.json', 'slip-big-2final.json', 'slip-big-3final.json', 'slip-big-4final.json', 'slip-big-5final.json']
const codes = ['X56AZ8', 'Z07AEM', 'WNNKBB', 'XBACX3', 'Z5ARLU']
const allResults = []
for (let fi = 0; fi < files.length; fi++) {
  const s = JSON.parse(readFileSync(files[fi], 'utf8'))
  const rows = []
  for (const l of s.legs) {
    try {
      const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${l.fixtureId}&productId=1`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
      const j = await r.json()
      const ev = j.data
      const status = ev?.matchStatus
      let home = null, away = null
      if (ev?.setScore && /^\d+:\d+$/.test(ev.setScore)) { const [h, a] = ev.setScore.split(':'); home = +h; away = +a }
      let win = null
      if ((status === 'Ended' || status === 'AET' || status === 'AP') && home != null && away != null) win = settleMarket(l.market, l.outcome, home, away)
      rows.push({ game: l.game, market: l.market, outcome: l.outcome, odds: l.odds, kickoff: l.kickoff, status, home, away, win })
    } catch (e) {
      rows.push({ game: l.game, market: l.market, outcome: l.outcome, status: 'ERR', error: String(e) })
    }
    await new Promise(r => setTimeout(r, 70))
  }
  allResults.push({ code: codes[fi], rows })
  console.log(`\n==== Slip ${fi + 1} (${codes[fi]}) ====`)
  for (const r of rows) {
    const mark = r.win === true ? 'WIN' : r.win === false ? 'LOSS' : `?(${r.status})`
    console.log(`${r.kickoff?.slice(5, 16) || ''} ${r.game} [${r.market} ${r.outcome}] @ ${r.odds} -> ${r.home != null ? r.home + '-' + r.away : ''} ${mark}`)
  }
  const ended = rows.filter(r => r.win !== null && r.win !== undefined)
  const losses = ended.filter(r => r.win === false)
  const unresolved = rows.filter(r => r.win === null || r.win === undefined)
  console.log(`Slip ${fi + 1} summary: ${ended.length - losses.length} wins, ${losses.length} losses, ${unresolved.length} unresolved -> ${losses.length === 0 && unresolved.length === 0 ? 'FULL WIN SO FAR' : losses.length > 0 ? 'CUT' : 'PENDING'}`)
}
writeFileSync('.bigday-results.json', JSON.stringify(allResults, null, 2))

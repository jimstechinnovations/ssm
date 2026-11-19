import { readFileSync } from 'node:fs'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const s = JSON.parse(readFileSync('slip-bball-20x.json', 'utf8'))

function parseSpecifier(spec) {
  const m = /total=(-?\d+(\.\d+)?)/.exec(spec || '')
  const h = /hcp=(-?\d+(\.\d+)?)/.exec(spec || '')
  return { total: m ? +m[1] : null, hcp: h ? +h[1] : null }
}

const rows = []
for (const l of s.legs) {
  let ev = null
  try {
    const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${l.fixtureId}&productId=1`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    const j = await r.json()
    ev = j.data
  } catch (e) {}
  const status = ev?.matchStatus
  let home = null, away = null
  if (ev?.setScore && /^\d+:\d+$/.test(ev.setScore)) { const [h, a] = ev.setScore.split(':'); home = +h; away = +a }
  let win = null
  const { total, hcp } = parseSpecifier(l.rawSpecifier)
  const ended = status === 'Ended' || status === 'AET' || status === 'AP' || status === 'Retired'
  if (ended && home != null && away != null) {
    if (l.rawMarketId === '223' && hcp != null) {
      // outcome text: "Home (+hcp)" or "Away (+hcp)" per our stored outcome string
      if (/Home \(/.test(l.outcome)) win = (home + hcp) > away
      else if (/Away \(/.test(l.outcome)) win = (away + hcp) > home
    } else if (l.rawMarketId === '225' && total != null) {
      const sum = home + away
      const pick = /(Over|Under)\s+[\d.]+$/.exec(l.outcome)
      if (pick && pick[1] === 'Over') win = sum > total
      else if (pick && pick[1] === 'Under') win = sum < total
    }
  }
  rows.push({ game: l.game, league: l.league, outcome: l.outcome, odds: l.odds, kickoff: l.kickoff, status, home, away, win })
  await new Promise(r => setTimeout(r, 70))
}
console.log('==== slip-bball-20x (code UAYVFG) ====')
for (const r of rows) {
  const mark = r.win === true ? 'WIN' : r.win === false ? 'LOSS' : `?(${r.status})`
  console.log(`${r.kickoff?.slice(0,16) || ''} ${r.game} [${r.outcome}] @ ${r.odds} -> ${r.home != null ? r.home + '-' + r.away : 'no score'} ${mark}`)
}
const wins = rows.filter(r => r.win === true).length
const losses = rows.filter(r => r.win === false).length
const unresolved = rows.filter(r => r.win !== true && r.win !== false).length
console.log(`summary: ${wins} wins, ${losses} losses, ${unresolved} unresolved`)

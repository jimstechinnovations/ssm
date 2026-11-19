import { readFileSync } from 'node:fs'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const cache = new Map()
async function getEvent(fid) {
  if (cache.has(fid)) return cache.get(fid)
  let ev = null
  for (const pid of [1, 3]) {
    try {
      const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${fid}&productId=${pid}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
      const j = await r.json()
      if (j.data) { ev = j.data; if (ev.setScore) break }
    } catch {}
  }
  cache.set(fid, ev)
  await new Promise(r => setTimeout(r, 60))
  return ev
}

function settle(l, ev) {
  const status = ev?.matchStatus
  const ended = status === 'Ended' || status === 'AET' || status === 'AP' || status === 'Retired'
  let home = null, away = null
  if (ev?.setScore && /^\d+:\d+$/.test(ev.setScore)) { const [h, a] = ev.setScore.split(':'); home = +h; away = +a }
  if (!ended || home == null) return { status: status || 'no-data', win: null, score: home != null ? `${home}-${away}` : '' }

  const mid = l.rawMarketId
  const spec = l.rawSpecifier || ''
  let win = null
  if (mid === '18') {
    const m = /total=(-?\d+(\.\d+)?)/.exec(spec); const total = m ? +m[1] : null
    const sum = home + away
    const pick = /(Over|Under)\s+[\d.]+$/.exec(l.outcome)
    if (total != null && pick) win = pick[1] === 'Over' ? sum > total : sum < total
  } else if (mid === '19' || mid === '20') {
    const m = /total=(-?\d+(\.\d+)?)/.exec(spec); const total = m ? +m[1] : null
    const own = mid === '19' ? home : away
    let pickType = null
    if (/Over/i.test(l.outcome)) pickType = 'Over'
    else if (/Under/i.test(l.outcome)) pickType = 'Under'
    else if (/\bO[\d.]/.test(l.outcome)) pickType = 'Over'
    else if (/\bU[\d.]/.test(l.outcome)) pickType = 'Under'
    if (total != null && pickType) win = pickType === 'Over' ? own > total : own < total
  } else if (mid === '10') {
    if (/home or draw/i.test(l.outcome)) win = home >= away
    else if (/draw or away/i.test(l.outcome)) win = away >= home
    else if (/home or away/i.test(l.outcome)) win = home !== away
  } else if (mid === '1') {
    if (/Home/i.test(l.outcome)) win = home > away
    else if (/Away/i.test(l.outcome)) win = away > home
    else if (/Draw/i.test(l.outcome)) win = home === away
  } else if (mid === '60200' || mid === '60100' || mid === '60110' || mid === '60180') {
    win = 'early/checkpoint-payout market: final score alone unreliable'
  } else if (mid === '223') {
    const h = /hcp=(-?\d+(\.\d+)?)/.exec(spec); const hcp = h ? +h[1] : null
    if (hcp != null) {
      if (/Home \(/.test(l.outcome)) win = (home + hcp) > away
      else if (/Away \(/.test(l.outcome)) win = (away + hcp) > home
    }
  } else if (mid === '225') {
    const m = /total=(-?\d+(\.\d+)?)/.exec(spec); const total = m ? +m[1] : null
    const sum = home + away
    const pick = /(Over|Under)\s+[\d.]+$/.exec(l.outcome)
    if (total != null && pick) win = pick[1] === 'Over' ? sum > total : sum < total
  }
  return { status, win, score: `${home}-${away}` }
}

const files = process.argv.slice(2)
for (const file of files) {
  const s = JSON.parse(readFileSync(file, 'utf8'))
  let w = 0, l_ = 0, unresolved = 0, unclear = 0
  const details = []
  for (const leg of s.legs) {
    const ev = await getEvent(leg.fixtureId)
    const r = settle(leg, ev)
    if (r.win === true) w++
    else if (r.win === false) l_++
    else if (typeof r.win === 'string') unclear++
    else unresolved++
    details.push({ game: leg.game, outcome: leg.outcome, status: r.status, score: r.score, win: r.win })
  }
  console.log(`\n${file}: W=${w} L=${l_} unclear=${unclear} unresolved=${unresolved} (of ${s.legs.length})`)
  for (const d of details) {
    if (d.win === false) console.log(`   LOSS: ${d.game} [${d.outcome}] ${d.score}`)
  }
}

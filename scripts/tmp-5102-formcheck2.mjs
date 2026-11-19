import { readFileSync } from 'node:fs'
const KEY = '1b4df77599756825d828b5902609b3227d6d798945fad669bc9347ba4e5b840f'
const picks = JSON.parse(readFileSync('.5102-picks.json', 'utf8'))
const check = picks.filter(p => /Nations League|UEFA|AFCON|Africa Cup|African Nations|CONCACAF/i.test(p.league))

function fmt(d) { return d.toISOString().slice(0,10) }
const to = new Date()
const from = new Date(Date.now() - 180*24*60*60*1000)

async function teamRecent(team) {
  const r = await fetch(`https://apiv3.apifootball.com/?action=get_events&from=${fmt(from)}&to=${fmt(to)}&team_name=${encodeURIComponent(team)}&APIkey=${KEY}`)
  const j = await r.json().catch(() => null)
  if (!Array.isArray(j)) return null
  const finished = j.filter(m => m.match_status === 'Finished' || (m.match_hometeam_score !== '' && m.match_hometeam_score != null))
  const goals = finished.map(m => parseInt(m.match_hometeam_score) + parseInt(m.match_awayteam_score)).filter(g => !isNaN(g))
  return goals
}

for (const p of check) {
  const [home, away] = p.game.split(' vs ')
  const [hg, ag] = await Promise.all([teamRecent(home), teamRecent(away)])
  const hAvg = hg && hg.length ? (hg.reduce((a,b)=>a+b,0)/hg.length).toFixed(2) : 'NO DATA'
  const aAvg = ag && ag.length ? (ag.reduce((a,b)=>a+b,0)/ag.length).toFixed(2) : 'NO DATA'
  console.log(p.game.padEnd(35), '| odds', p.odds, `| ${home}: n=${hg?hg.length:0} avg=${hAvg}`, `| ${away}: n=${ag?ag.length:0} avg=${aAvg}`)
}

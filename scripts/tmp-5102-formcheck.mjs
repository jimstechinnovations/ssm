import { readFileSync } from 'node:fs'
const KEY = '1b4df77599756825d828b5902609b3227d6d798945fad669bc9347ba4e5b840f'
const picks = JSON.parse(readFileSync('.5102-picks.json', 'utf8'))
const check = picks.filter(p => /Nations League|UEFA|AFCON|Africa Cup|African Nations|CONCACAF/i.test(p.league))

function recentGF(team) {
  return fetch(`https://apiv3.apifootball.com/?action=get_H2H&firstTeam=${encodeURIComponent(team)}&secondTeam=x&APIkey=${KEY}`).catch(() => null)
}

async function teamAvgGoals(teamName) {
  try {
    const r = await fetch(`https://apiv3.apifootball.com/?action=get_teams&team_name=${encodeURIComponent(teamName)}&APIkey=${KEY}`)
    const j = await r.json()
    return j
  } catch (e) { return null }
}

for (const p of check) {
  const [home, away] = p.game.split(' vs ')
  const r = await fetch(`https://apiv3.apifootball.com/?action=get_H2H&firstTeam=${encodeURIComponent(home)}&secondTeam=${encodeURIComponent(away)}&APIkey=${KEY}`)
  const j = await r.json().catch(() => null)
  const h2h = j?.firstTeam_VS_secondTeam || []
  const last = h2h.slice(0, 5)
  let goals = []
  for (const m of last) {
    const hs = parseInt(m.match_hometeam_score), as = parseInt(m.match_awayteam_score)
    if (!isNaN(hs) && !isNaN(as)) goals.push(hs + as)
  }
  const avg = goals.length ? (goals.reduce((a,b)=>a+b,0)/goals.length).toFixed(2) : 'NO DATA'
  console.log(p.game.padEnd(35), '|', p.league.padEnd(35), '| odds', p.odds, '| H2H games:', goals.length, '| avg combined goals:', avg)
}

const KEY = '1b4df77599756825d828b5902609b3227d6d798945fad669bc9347ba4e5b840f'
const games = [
  ['Municipal Limeno', 'CD Fuerte San Francisco'],
  ['Albacete Balompie', 'RC Celta Fortuna'],
  ['Santiago Morning', 'Deportes Rengo'],
  ['Cusco FC', 'Asociacion Deportiva Tarma'],
  ['UTC de Cajamarca', 'Los Chankas CYC'],
]

function fmt(d) { return d.toISOString().slice(0,10) }
const to = new Date()
const from = new Date(Date.now() - 120*24*60*60*1000)

async function teamRecent(team) {
  const r = await fetch(`https://apiv3.apifootball.com/?action=get_events&from=${fmt(from)}&to=${fmt(to)}&team_name=${encodeURIComponent(team)}&APIkey=${KEY}`)
  const j = await r.json().catch(() => null)
  if (!Array.isArray(j)) return []
  return j.filter(m => m.match_hometeam_score !== '' && m.match_hometeam_score != null)
    .slice(-6)
    .map(m => ({ date: m.match_date, home: m.match_hometeam_name, away: m.match_awayteam_name, score: `${m.match_hometeam_score}-${m.match_awayteam_score}` }))
}

for (const [home, away] of games) {
  console.log(`\n== ${home} vs ${away} ==`)
  const [h, a] = await Promise.all([teamRecent(home), teamRecent(away)])
  console.log(` ${home} last matches:`, h.length ? h.map(m=>`${m.date} ${m.home} ${m.score} ${m.away}`).join(' | ') : 'NO DATA')
  console.log(` ${away} last matches:`, a.length ? a.map(m=>`${m.date} ${m.home} ${m.score} ${m.away}`).join(' | ') : 'NO DATA')
  function avgGoals(arr, team) {
    if (!arr.length) return null
    let tot = 0
    for (const m of arr) {
      const [hs, as] = m.score.split('-').map(Number)
      tot += hs + as
    }
    return (tot / arr.length).toFixed(2)
  }
  console.log(` combined-goals avg | ${home}: ${avgGoals(h)} | ${away}: ${avgGoals(a)}`)
}

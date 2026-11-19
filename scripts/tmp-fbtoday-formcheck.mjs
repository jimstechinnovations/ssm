import { readFileSync } from 'node:fs'
const KEY = '1b4df77599756825d828b5902609b3227d6d798945fad669bc9347ba4e5b840f'
const BASE = 'https://apiv3.apifootball.com'
const picks = JSON.parse(readFileSync('.fbtoday-picks.json', 'utf8')).slice(0, 45)

function last5(results, teamName) {
  if (!results || !results.length) return null
  const rows = results.slice(0, 5)
  let w = 0, d = 0, l = 0, gf = 0
  for (const m of rows) {
    const isHome = m.match_hometeam_name?.toLowerCase() === teamName.toLowerCase()
    const hs = +m.match_hometeam_score, as = +m.match_awayteam_score
    if (Number.isNaN(hs) || Number.isNaN(as)) continue
    const my = isHome ? hs : as, opp = isHome ? as : hs
    gf += my
    if (my > opp) w++; else if (my === opp) d++; else l++
  }
  return { w, d, l, gf: rows.length ? +(gf / rows.length).toFixed(1) : 0 }
}

async function h2h(home, away) {
  const url = `${BASE}/?action=get_H2H&firstTeam=${encodeURIComponent(home)}&secondTeam=${encodeURIComponent(away)}&APIkey=${KEY}`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    const j = await r.json()
    clearTimeout(t)
    return j
  } catch (e) { clearTimeout(t); return null }
}

for (const p of picks) {
  const [home, away] = p.game.split(' vs ')
  const j = await h2h(home, away)
  const homeRes = j?.firstTeam_lastResults || []
  const awayRes = j?.secondTeam_lastResults || []
  const hf = last5(homeRes, home)
  const af = last5(awayRes, away)
  const combinedGF = (hf && af) ? +(hf.gf + af.gf).toFixed(1) : null
  console.log(`${p.game} | ${p.league} | odds ${p.odds} | HOME: ${hf ? hf.w+'W'+hf.d+'D'+hf.l+'L gf'+hf.gf : 'no data'} | AWAY: ${af ? af.w+'W'+af.d+'D'+af.l+'L gf'+af.gf : 'no data'} | combinedGF: ${combinedGF ?? '-'}`)
  await new Promise(r => setTimeout(r, 120))
}

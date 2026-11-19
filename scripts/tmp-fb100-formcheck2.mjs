import { readFileSync, writeFileSync } from 'node:fs'

let APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY?.trim()
if (!APIFOOTBALL_KEY) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY?.trim()
}
const BASE = process.env.APIFOOTBALL_URL?.trim() || 'https://apiv3.apifootball.com'

function summarize(arr, teamNameHint) {
  const clean = (arr || []).filter(r => r.match_hometeam_score !== '' && r.match_hometeam_score != null)
  let w = 0, l = 0, d = 0, gf = 0, ga = 0, n = 0
  for (const r of clean.slice(0, 5)) {
    const isHome = r.match_hometeam_name === teamNameHint
    const scored = isHome ? +r.match_hometeam_score : +r.match_awayteam_score
    const conceded = isHome ? +r.match_awayteam_score : +r.match_hometeam_score
    gf += scored; ga += conceded; n++
    if (scored > conceded) w++; else if (scored < conceded) l++; else d++
  }
  return n ? { w, d, l, n, gfAvg: +(gf / n).toFixed(2), gaAvg: +(ga / n).toFixed(2) } : null
}

async function h2h(home, away) {
  const url = `${BASE}/?action=get_H2H&firstTeam=${encodeURIComponent(home)}&secondTeam=${encodeURIComponent(away)}&APIkey=${APIFOOTBALL_KEY}`
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer))
    if (!res.ok) return null
    const j = await res.json().catch(() => null)
    if (!j) return null
    const homeForm = summarize(j.firstTeam_lastResults, home)
    const awayForm = summarize(j.secondTeam_lastResults, away)
    return { homeForm, awayForm }
  } catch { return null }
}

const s = JSON.parse(readFileSync('slip-fb100-100x.json', 'utf8'))
const out = []
let i = 0
for (const l of s.legs) {
  const [home, away] = l.game.split(' vs ')
  const r = await h2h(home, away)
  out.push({ game: l.game, home, away, pick: l.outcome, odds: l.odds, kickoff: l.kickoff, homeForm: r?.homeForm || null, awayForm: r?.awayForm || null })
  i++
  if (i % 10 === 0) console.log('progress', i, '/', s.legs.length)
}
writeFileSync('.fb100-formcheck.json', JSON.stringify(out))
console.log('done', out.length, 'with any form data:', out.filter(x => x.homeForm || x.awayForm).length)

import { readFileSync } from 'node:fs'
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const KEY = process.env.APIFOOTBALL_KEY
const BASE = process.env.APIFOOTBALL_URL || 'https://apiv3.apifootball.com'

async function lastGoals(team) {
  const url = `${BASE}/?action=get_teams&team_name=${encodeURIComponent(team)}&APIkey=${KEY}`
  try {
    const r = await fetch(url); const j = await r.json()
    return Array.isArray(j) ? j[0]?.team_key : null
  } catch { return null }
}

async function h2h(home, away) {
  const url = `${BASE}/?action=get_H2H&firstTeam=${encodeURIComponent(home)}&secondTeam=${encodeURIComponent(away)}&APIkey=${KEY}`
  try {
    const r = await fetch(url); const j = await r.json()
    if (!j || j.error) return null
    return j
  } catch { return null }
}

const pairs = [
  ['Kazakhstan U19', 'Scotland U19'],
  ['Serbia U19', 'Faroe Islands U19'],
  ['Austria U19', 'Belarus U19'],
  ['Sheffield Wednesday', 'Accrington Stanley'],
]
for (const [h, a] of pairs) {
  const j = await h2h(h, a)
  console.log('===', h, 'vs', a)
  if (!j) { console.log('  no H2H data'); continue }
  const clean = (arr) => (arr || []).filter(r => r.match_hometeam_score !== '' && r.match_hometeam_score != null)
  const hr = clean(j.firstTeam_lastResults).slice(0, 5)
  const ar = clean(j.secondTeam_lastResults).slice(0, 5)
  console.log(' ', h, 'last 5:', hr.map(r => `${r.match_hometeam_name} ${r.match_hometeam_score}-${r.match_awayteam_score} ${r.match_awayteam_name}`).join(' | '))
  console.log(' ', a, 'last 5:', ar.map(r => `${r.match_hometeam_name} ${r.match_hometeam_score}-${r.match_awayteam_score} ${r.match_awayteam_name}`).join(' | '))
}

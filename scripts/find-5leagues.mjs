import { writeFileSync } from 'node:fs'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const FROM = Date.now()
const TO = new Date('2026-10-26T00:00:00Z').getTime()
const wanted = [
  { country: 'england', league: 'premier league' },
  { country: 'spain', league: 'laliga' },
  { country: 'italy', league: 'serie a' },
  { country: 'germany', league: 'bundesliga' },
  { country: 'france', league: 'ligue 1' },
]
const found = []
for (let pg = 1; pg <= 40; pg++) {
  const res = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr:sport:1&marketId=1&pageSize=100&pageNum=' + pg, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  const json = await res.json()
  if (json.bizCode !== 10000 || !json.data?.tournaments?.length) break
  let pageEvents = 0
  for (const t of json.data.tournaments) {
    pageEvents += (t.events || []).length
    const lname = (t.name || '').toLowerCase()
    for (const ev of t.events || []) {
      const cname = (ev.sport?.category?.name || '').toLowerCase()
      if (!wanted.some(w => cname === w.country && lname === w.league)) continue
      if (ev.estimateStartTime < FROM || ev.estimateStartTime > TO) continue
      found.push({ fixtureId: Number(String(ev.eventId).split(':').pop()), game: ev.homeTeamName + ' vs ' + ev.awayTeamName, league: t.name, country: ev.sport?.category?.name, time: new Date(ev.estimateStartTime).toISOString() })
    }
  }
  if (pageEvents === 0) break
}
found.sort((a, b) => new Date(a.time) - new Date(b.time))
console.log(found.length, 'fixtures in the 5 big leagues over next 2 weeks')
writeFileSync('.5leagues-fixtures.json', JSON.stringify(found, null, 2))
for (const f of found) console.log(f.time, f.game, '|', f.league)

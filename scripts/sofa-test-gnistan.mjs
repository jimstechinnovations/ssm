import { chromium } from 'playwright'
const b = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = b.contexts()[0]
const page = ctx.pages().find(p => /sportybet\.com|sofascore\.com/.test(p.url())) || await ctx.newPage()
if (!/sofascore\.com/.test(page.url())) { await page.goto('https://www.sofascore.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await page.waitForTimeout(2000) }

async function lookup(name) {
  return page.evaluate(async (teamName) => {
    const g = async (u) => { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return { s: r.status, t: await r.text() } }
    const s = await g(`https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(teamName)}`)
    let team = null, matches = []
    try {
      const d = JSON.parse(s.t)
      const t = (d.results || []).find(x => x.type === 'team')
      if (t) {
        team = { name: t.entity.name, id: t.entity.id }
        const ev = await g(`https://api.sofascore.com/api/v1/team/${t.entity.id}/events/last/0`)
        const e = JSON.parse(ev.t).events || []
        matches = e.filter(x => x.status?.type === 'finished').slice(-10).map(m => ({
          date: new Date(m.startTimestamp * 1000).toISOString().slice(0, 10),
          home: m.homeTeam.name, away: m.awayTeam.name,
          hg: m.homeScore.current, ag: m.awayScore.current,
        }))
      }
    } catch (e) { return { searchStatus: s.s, err: e.message } }
    return { searchStatus: s.s, team, matches }
  }, name)
}

console.log('Gnistan:', JSON.stringify(await lookup('IF Gnistan'), null, 1))
console.log('\nTampereen Ilves:', JSON.stringify(await lookup('Tampereen Ilves'), null, 1))
await b.close()

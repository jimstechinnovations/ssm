import { chromium } from 'playwright'
const b = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = b.contexts()[0]
const page = await ctx.newPage()
await page.goto('https://www.sofascore.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{})
await page.waitForTimeout(4000)
const out = await page.evaluate(async () => {
  const g = async (u) => { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return { s: r.status, t: await r.text() } }
  const s = await g('https://api.sofascore.com/api/v1/search/all?q=Molde')
  let team=null, matches=[]
  try { const d=JSON.parse(s.t); const t=(d.results||[]).find(x=>x.type==='team'); if(t){team={name:t.entity.name,id:t.entity.id}
    const ev=await g(`https://api.sofascore.com/api/v1/team/${t.entity.id}/events/last/0`); const e=JSON.parse(ev.t).events||[]
    matches=e.filter(x=>x.status?.type==='finished').slice(-3).map(m=>`${m.homeTeam.name} ${m.homeScore.current}-${m.awayScore.current} ${m.awayTeam.name}`)
  }} catch(e){ return { searchStatus:s.s, err:e.message, sample:s.t.slice(0,100) } }
  return { searchStatus: s.s, team, matches }
})
console.log(JSON.stringify(out, null, 1))
await page.close(); await b.close()

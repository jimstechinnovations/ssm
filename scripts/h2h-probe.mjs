import { chromium } from 'playwright'
const b = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = await b.contexts()[0].newPage()
await page.goto('https://www.sofascore.com/', { waitUntil:'domcontentloaded', timeout:60000 }).catch(()=>{})
await page.waitForTimeout(3500)
const g=(u)=>page.evaluate(async(x)=>{try{const r=await fetch(x,{headers:{Accept:'application/json'}});return r.ok?await r.json():null}catch{return null}},u)
async function team(n){const s=await g(`https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(n)}`);const t=(s?.results||[]).find(r=>r.type==='team')?.entity;return t?{id:t.id,name:t.name}:null}
for (const [H,A] of [['Molde','Brann'],['Beijing Guoan','Liaoning Tieren']]) {
  const [th,ta]=await Promise.all([team(H),team(A)])
  if(!th||!ta){console.log(`${H} vs ${A}: team not found (${th?.name}/${ta?.name})`);continue}
  const ev=(await g(`https://api.sofascore.com/api/v1/team/${th.id}/events/last/0`))?.events||[]
  const h2h=ev.filter(e=>e.status?.type==='finished'&&(e.homeTeam.id===ta.id||e.awayTeam.id===ta.id))
  console.log(`${th.name} vs ${ta.name}: ${h2h.length} H2H in last page`)
  for(const e of h2h.slice(-4))console.log(`   ${e.homeTeam.name} ${e.homeScore.current}-${e.awayScore.current} ${e.awayTeam.name} = ${e.homeScore.current+e.awayScore.current} goals`)
}
await page.close();await b.close()

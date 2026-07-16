import { chromium } from 'playwright'
const N = Number(process.argv[2] || 40)
// 1. fetch N qualifying Under 4.5 legs (next 3 days)
const cands=[]
for (let pg=1; pg<=8 && cands.length<N+5; pg++) {
  const r=await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=18&pageSize=100&pageNum='+pg,{headers:{'User-Agent':'Mozilla/5.0'}})
  const j=await r.json(); if(!j.data||!j.data.tournaments)break
  const minKick=Date.now()+45*60*1000, maxKick=Date.now()+3*24*3600*1000
  for (const t of j.data.tournaments) for (const ev of (t.events||[])) {
    if (ev.estimateStartTime<minKick||ev.estimateStartTime>maxKick) continue
    const m=(ev.markets||[]).find(x=>x.specifier==='total=4.5'); if(!m)continue
    const u=m.outcomes.find(o=>/under/i.test(o.desc)), o=m.outcomes.find(x=>/over/i.test(x.desc))
    if(!u||!o) continue; const uo=+u.odds
    if (uo<1.20 || uo>=(+o.odds)) continue
    cands.push({id:+ev.eventId.split(':').pop(), odds:uo})
  }
}
const legs=cands.slice(0,N)
const rawO=legs.reduce((a,l)=>a*l.odds,1)
console.log(`built ${legs.length} legs · raw combined odds ${rawO.toExponential(3)} · raw ₦10 payout ₦${Math.round(10*rawO).toLocaleString()}`)
// 2. booking code
const sel=legs.map(l=>({eventId:'sr:match:'+l.id, marketId:'18', specifier:'total=4.5', outcomeId:'13'}))
const share=await (await fetch('https://www.sportybet.com/api/ng/orders/share',{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0',platform:'web'},body:JSON.stringify({selections:sel,shareType:1})})).json()
if(share.bizCode!==10000){ console.log('booking code failed — maybe too many legs? bizCode', share.bizCode, share.message); process.exit(0) }
const code=share.data.shareCode
console.log('booking code:', code, '(SportyBet accepted', legs.length, 'legs)')
// 3. load in betslip + read payout
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222')
const page=browser.contexts()[0].pages().find(p=>/sportybet/.test(p.url()))
const dl=(rs)=>page.evaluate(s=>{const rx=new RegExp(s,'i');const e=[...document.querySelectorAll('span,div,a,button')].find(x=>x.children.length===0&&rx.test((x.textContent||'').trim())&&(x.offsetWidth||x.offsetHeight));if(e){e.click();return true}return false},rs)
const okBtn=()=>page.locator('.es-dialog-wrap:visible .es-dialog-btn, [class*=dialog-wrap] [class*=dialog-btn]',{hasText:/^OK$/i}).first()
for(let i=0;i<10;i++){ if(await page.locator('input[placeholder="Booking Code"]:visible').count())break
  if(await page.evaluate(()=>/about to pay/i.test(document.body.innerText))){ await dl('^cancel$'); await page.waitForTimeout(700); continue }
  if(await okBtn().count()){ await okBtn().click({force:true}).catch(()=>{}); await page.waitForTimeout(800); continue }  // "Remove Betslip? OK"
  const ra=await page.locator('[data-cms-key=remove_all]:visible').count(); if(ra){ await page.locator('[data-cms-key=remove_all]:visible').first().click({force:true}).catch(()=>{}); await page.waitForTimeout(800); continue }
  const d=await page.locator('[class*=betslip] [class*=icon-delete]:visible').count(); if(d){ await page.locator('[class*=betslip] [class*=icon-delete]:visible').first().click({force:true}).catch(()=>{}); await page.waitForTimeout(600); continue }
  await page.waitForTimeout(600) }
const ci=page.locator('input[placeholder="Booking Code"]').first(); await ci.click(); await ci.type(code,{delay:40}); await page.waitForTimeout(800)
await page.locator('[class*=betslip] >> text=/^Load$/i').first().click(); await page.waitForTimeout(6000)
const sb=page.locator('input[placeholder^="min."]').first(); await sb.click({clickCount:3}).catch(()=>{}); await sb.press('Delete').catch(()=>{}); await sb.type('10',{delay:60}); await page.waitForTimeout(2000)
const t=await page.evaluate(()=>{const p=[...document.querySelectorAll('[class*=betslip]')].filter(e=>e.offsetHeight).sort((a,b)=>b.innerText.length-a.innerText.length)[0];return p?p.innerText:''})
const legCount=(t.match(/Over\/Under/g)||[]).length
console.log('--- SportyBet betslip (loaded) ---')
console.log('legs shown:', legCount)
console.log('Odds:', t.match(/\bOdds\s+([\d,.]+)/i)?.[1])
console.log('Total Stake:', t.match(/Total Stake\s+([\d,.]+)/i)?.[1])
console.log('Max bonus:', t.match(/Max bonus\s+([\d,.]+)/i)?.[1])
console.log('Potential Win:', t.match(/Potential Win\s*\n?\s*([\d,.]+)/i)?.[1])
await browser.close()

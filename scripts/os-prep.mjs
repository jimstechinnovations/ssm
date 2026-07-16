/** Set stake, scroll Place Bet into view, record balance + physical coords for the OS click. */
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
const [outFile, stake] = [process.argv[2], process.argv[3] ?? '10']
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(800)
const bal = async () => { const m=(await page.evaluate(()=>document.body.innerText)).match(/NGN\s*([\d,.]+)/); return m?parseFloat(m[1].replace(/,/g,'')):NaN }
const before = await bal()
// set stake
const sb = page.locator('input[placeholder^="min."]').first()
await sb.scrollIntoViewIfNeeded().catch(()=>{})
await sb.click(); await sb.fill(''); await sb.type(String(stake), { delay: 90 })
await page.waitForTimeout(1200)
const info = await page.evaluate(() => {
  const els=[...document.querySelectorAll('button,[class*=place],[class*=btn]')].filter(e=>/place bet/i.test(e.textContent||'')&&(e.offsetWidth*e.offsetHeight))
  els.sort((a,b)=>(b.offsetWidth*b.offsetHeight)-(a.offsetWidth*a.offsetHeight)); const b=els[0]; if(!b)return null
  b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect()
  const st=[...document.querySelectorAll('[class*=betslip]')].filter(e=>e.offsetHeight).sort((x,y)=>y.innerText.length-x.innerText.length)[0]
  return { vx:r.left+r.width/2, vy:r.top+r.height/2, screenX:window.screenX, screenY:window.screenY, innerH:window.innerHeight, outerH:window.outerHeight, dpr:window.devicePixelRatio, stakeText:(st?.innerText.match(/Total Stake\s+([\d,.]+)/i)?.[1]||'') }
})
await new Promise(r=>setTimeout(r,400))
const physX=Math.round((info.screenX+info.vx)*info.dpr), physY=Math.round((info.screenY+(info.outerH-info.innerH)+info.vy)*info.dpr)
const out={ before, stakeText:info.stakeText, physX, physY }
writeFileSync(outFile, JSON.stringify(out)); console.log(JSON.stringify(out))
await browser.close()

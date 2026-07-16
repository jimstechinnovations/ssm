/** Find the "Confirm" button in the About-to-pay dialog; emit its physical screen coords. */
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
const outFile = process.argv[2]
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.waitForTimeout(300)
const bal = (await page.evaluate(()=>document.body.innerText)).match(/NGN\s*([\d,.]+)/)?.[1]
const info = await page.evaluate(() => {
  const els=[...document.querySelectorAll('button,[class*=btn],[class*=confirm]')]
    .filter(e=>/^confirm$/i.test((e.textContent||'').trim())&&(e.offsetWidth*e.offsetHeight))
  els.sort((a,b)=>(b.offsetWidth*b.offsetHeight)-(a.offsetWidth*a.offsetHeight)); const b=els[0]; if(!b)return null
  const r=b.getBoundingClientRect()
  return { vx:r.left+r.width/2, vy:r.top+r.height/2, screenX:window.screenX, screenY:window.screenY, innerH:window.innerHeight, outerH:window.outerHeight, dpr:window.devicePixelRatio }
})
if (!info) { console.log(JSON.stringify({ balance: bal, confirmFound: false })); await browser.close(); process.exit(0) }
const physX=Math.round((info.screenX+info.vx)*info.dpr), physY=Math.round((info.screenY+(info.outerH-info.innerH)+info.vy)*info.dpr)
const out={ balance: bal, confirmFound: true, physX, physY }
if (outFile) writeFileSync(outFile, JSON.stringify(out))
console.log(JSON.stringify(out))
await browser.close()

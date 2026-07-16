/** Measure whatever's actionable in the maximized SportyBet betslip: Confirm (if the pay dialog is
 *  up) else Place Bet. Emit physical screen coords + balance + which button. */
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
const outFile = process.argv[2]
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.waitForTimeout(400)
const bal = (await page.evaluate(()=>document.body.innerText)).match(/NGN\s*([\d,.]+)/)?.[1]
const r = await page.evaluate(() => {
  const vis = e => e && (e.offsetWidth*e.offsetHeight)
  const pick = (re) => { const els=[...document.querySelectorAll('button,[class*=btn],[class*=confirm],[class*=place]')].filter(e=>re.test((e.textContent||'').trim())&&vis(e)); els.sort((a,b)=>(b.offsetWidth*b.offsetHeight)-(a.offsetWidth*a.offsetHeight)); return els[0]||null }
  // "About to pay ... Confirm" dialog takes priority
  const confirm = pick(/^confirm$/i)
  const place = pick(/^place bet$/i)
  const btn = confirm || place
  if (!btn) return null
  const which = confirm ? 'confirm' : 'place'
  btn.scrollIntoView({ block: 'center' })   // ensure it's on-screen before measuring
  const rect = btn.getBoundingClientRect()
  return { which, vx:rect.left+rect.width/2, vy:rect.top+rect.height/2, screenX:window.screenX, screenY:window.screenY, innerH:window.innerHeight, outerH:window.outerHeight, dpr:window.devicePixelRatio }
})
if (!r) { console.log(JSON.stringify({ balance: bal, actionable: null })); await browser.close(); process.exit(0) }
const physX=Math.round((r.screenX+r.vx)*r.dpr), physY=Math.round((r.screenY+(r.outerH-r.innerH)+r.vy)*r.dpr)
const out={ balance: bal, actionable: r.which, physX, physY }
if (outFile) writeFileSync(outFile, JSON.stringify(out))
console.log(JSON.stringify(out))
await browser.close()

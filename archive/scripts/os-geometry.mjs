/** Scroll Place Bet into view, emit its physical screen coords + the window title for foregrounding. */
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
const outFile = process.argv[2]
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(800)
const title = await page.title()
const info = await page.evaluate(() => {
  const els = [...document.querySelectorAll('button, [class*=place], [class*=btn]')]
    .filter(e => /place bet/i.test(e.textContent||'') && (e.offsetWidth*e.offsetHeight))
  els.sort((a,b)=>(b.offsetWidth*b.offsetHeight)-(a.offsetWidth*a.offsetHeight))
  const btn = els[0]; if (!btn) return null
  btn.scrollIntoView({ block:'center' })
  const r = btn.getBoundingClientRect()
  return { vx:r.left+r.width/2, vy:r.top+r.height/2, screenX:window.screenX, screenY:window.screenY,
           innerH:window.innerHeight, outerH:window.outerHeight, dpr:window.devicePixelRatio }
})
if (!info) { console.error('no Place Bet'); process.exit(1) }
await new Promise(r=>setTimeout(r,500))
const chromeTop = info.outerH - info.innerH
const physX = Math.round((info.screenX + info.vx) * info.dpr)
const physY = Math.round((info.screenY + chromeTop + info.vy) * info.dpr)
const out = { title, physX, physY, dpr: info.dpr, vx: info.vx, vy: info.vy }
writeFileSync(outFile, JSON.stringify(out))
console.log(JSON.stringify(out))
await browser.close()

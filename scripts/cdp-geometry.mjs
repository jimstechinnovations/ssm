/** Print the Place Bet button's absolute SCREEN coordinates for OS-level clicking. */
import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(1000)

// find the actual green Place Bet BUTTON (not just the text), scroll into view
const info = await page.evaluate(() => {
  const els = [...document.querySelectorAll('button, [class*=place], [class*=btn]')]
    .filter(e => /place bet/i.test(e.textContent||'') && (e.offsetWidth||e.offsetHeight))
  // prefer the largest (the actual button, not the text span)
  els.sort((a,b) => (b.offsetWidth*b.offsetHeight) - (a.offsetWidth*a.offsetHeight))
  const btn = els[0]
  if (!btn) return null
  btn.scrollIntoView({ block: 'center' })
  const r = btn.getBoundingClientRect()
  return {
    vx: r.left + r.width/2, vy: r.top + r.height/2, w: r.width, h: r.height,
    screenX: window.screenX, screenY: window.screenY,
    innerW: window.innerWidth, innerH: window.innerHeight,
    outerW: window.outerWidth, outerH: window.outerHeight,
    dpr: window.devicePixelRatio,
    tag: btn.tagName, cls: btn.className,
  }
})
if (!info) { console.error('no Place Bet button'); process.exit(1) }
await new Promise(r=>setTimeout(r,600))
// chrome UI height = outerH - innerH (title+tabs+addressbar); left border usually ~0
const chromeTop = info.outerH - info.innerH
// logical screen coords (SetCursorPos with a DPI-aware process uses physical; we'll pass dpr too)
const logicalX = info.screenX + info.vx
const logicalY = info.screenY + chromeTop + info.vy
console.log(JSON.stringify({ ...info, chromeTop, logicalX: Math.round(logicalX), logicalY: Math.round(logicalY), physX: Math.round(logicalX*info.dpr), physY: Math.round(logicalY*info.dpr) }, null, 1))
await browser.close()

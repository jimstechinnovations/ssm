import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.waitForTimeout(300)
const payUp = await page.evaluate(() => /about to pay/i.test(document.body.innerText))
const conf = await page.evaluate(() => {
  const vis = e => e && (e.offsetWidth * e.offsetHeight)
  const els = [...document.querySelectorAll('button, [class*=btn], [class*=confirm], [class*=place], span, div, a')]
    .filter(e => e.children.length === 0 && /^confirm$/i.test((e.textContent||'').trim()) && vis(e))
  els.sort((a,b)=>(a.offsetWidth*a.offsetHeight)-(b.offsetWidth*b.offsetHeight))
  const btn = els[0]; if (!btn) return null
  const r = btn.getBoundingClientRect()
  return { tag: btn.tagName, w: Math.round(r.width), h: Math.round(r.height),
    physX: Math.round((window.screenX+r.left+r.width/2)*window.devicePixelRatio),
    physY: Math.round((window.screenY+(window.outerHeight-window.innerHeight)+r.top+r.height/2)*window.devicePixelRatio) }
})
console.log('pay dialog up:', payUp, '| confirm found:', JSON.stringify(conf))
await browser.close()

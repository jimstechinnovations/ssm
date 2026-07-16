import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.waitForTimeout(500)
const body = await page.evaluate(()=>document.body.innerText)
console.log('about to pay present:', /about to pay/i.test(body))
console.log('insufficient/not-enough present:', /insufficient|not enough|top ?up|deposit to/i.test(body))
// show any dialog-ish text
const dlg = await page.evaluate(()=>{
  const vis=e=>e&&(e.offsetWidth||e.offsetHeight)
  const w=[...document.querySelectorAll('[class*=dialog],[class*=modal],[class*=mask],[class*=popup],[class*=toast],[class*=tip]')].filter(vis)
  return w.map(e=>e.innerText.slice(0,80).replace(/\n/g,' ')).filter(t=>t.trim()).slice(0,5)
})
console.log('visible dialog/toast text:', JSON.stringify(dlg))
await browser.close()

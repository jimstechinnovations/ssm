import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront(); await page.waitForTimeout(800)
const s = await page.evaluate(() => {
  const vis = e => !!(e && (e.offsetWidth||e.offsetHeight))
  const dialogs = [...document.querySelectorAll('[class*=dialog],[class*=mask],[id*=Dialog],[class*=modal]')].filter(vis).map(e=>({cls:(e.className||e.id||'').toString().slice(0,50), text:e.innerText.slice(0,120)}))
  const codeBox = document.querySelector('input[placeholder="Booking Code"]')
  const betslip = [...document.querySelectorAll('[class*=betslip]')].filter(vis).sort((a,b)=>b.innerText.length-a.innerText.length)[0]
  const btns = [...document.querySelectorAll('button,[class*=btn]')].filter(vis).map(e=>e.textContent.trim().slice(0,20)).filter(Boolean).slice(0,15)
  return { url: location.href, tabs: document.querySelectorAll('[class*=betslip]').length, codeBoxExists: !!codeBox, codeBoxVisible: vis(codeBox), dialogs, betslipText: betslip?betslip.innerText.slice(0,400):'(none)', buttons: btns }
})
console.log(JSON.stringify(s, null, 1))
await browser.close()

import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.waitForTimeout(300)
const s = await page.evaluate(() => {
  const vis = e => !!(e && (e.offsetWidth || e.offsetHeight))
  const wraps = [...document.querySelectorAll('[class*=dialog], [class*=modal], [class*=popup], [class*=mask]')].filter(vis)
    .map(e => ({ cls: (e.className||'').toString().slice(0,45), text: e.innerText.slice(0,90).replace(/\n/g,' ') }))
  const confirmBtns = [...document.querySelectorAll('*')].filter(e => vis(e) && /^confirm$/i.test((e.textContent||'').trim()) && e.children.length===0)
    .map(e => ({ tag:e.tagName, cls:(e.className||'').toString().slice(0,40) }))
  const bodyHasPay = /about to pay/i.test(document.body.innerText)
  return { visibleDialogs: wraps, confirmBtns, bodyHasPay }
})
console.log(JSON.stringify(s, null, 1))
await browser.close()

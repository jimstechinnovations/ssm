import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.waitForTimeout(400)
const info = await page.evaluate(() => {
  const vis = e => e && (e.offsetWidth || e.offsetHeight)
  const bs = [...document.querySelectorAll('[class*=betslip]')].filter(vis).sort((a,b)=>b.innerText.length-a.innerText.length)[0]
  if (!bs) return {none:true}
  // candidate remove controls inside the betslip
  const cands = [...bs.querySelectorAll('*')].filter(e => vis(e) && e.children.length===0 && /remove|close|del|clear|×|✕|icon-x/i.test((e.className||'')+(e.textContent||'')))
    .map(e => ({ tag:e.tag||e.tagName, cls:(e.className||'').toString().slice(0,45), text:(e.textContent||'').trim().slice(0,10) }))
  const removeAll = [...document.querySelectorAll('[data-cms-key=remove_all]')].map(e=>({visible:vis(e), cls:(e.className||'').slice(0,40)}))
  return { legCount:(bs.innerText.match(/Over\/Under/g)||[]).length, removeControls:cands.slice(0,12), removeAll }
})
console.log(JSON.stringify(info, null, 1))
await browser.close()

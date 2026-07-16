/** The dialog is up. Does a CDP click on Confirm REGISTER? At ₦0 it can't place — "insufficient"
 *  means the CDP Confirm fired the placement (so CDP would place if funded); nothing means Confirm
 *  is genuinely gated against CDP. Safe: ₦0 balance can't commit money. */
import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.waitForTimeout(400)
console.log('pay dialog up before:', await page.evaluate(()=>/about to pay/i.test(document.body.innerText)))
// capture any order POST
let orderPost = null
page.on('response', r => { if(/orders\/order/.test(r.url())) orderPost = r.status() })
// native CDP click on the Confirm span
const clicked = await page.evaluate(()=>{
  const vis=e=>e&&(e.offsetWidth||e.offsetHeight)
  const el=[...document.querySelectorAll('span,div,a,button')].find(e=>e.children.length===0&&/^confirm$/i.test((e.textContent||'').trim())&&vis(e))
  if(el){el.click();return true}return false
})
console.log('CDP clicked Confirm span:', clicked)
await page.waitForTimeout(4000)
const body = await page.evaluate(()=>document.body.innerText)
console.log('order POST fired:', orderPost)
console.log('insufficient/not-enough now:', /insufficient|not enough|top ?up|balance is|deposit/i.test(body))
console.log('submission successful:', /submission successful/i.test(body))
console.log('pay dialog still up:', /about to pay/i.test(body))
const snip = body.match(/(insufficient|not enough|balance|deposit|submission|failed|error)[^\n]{0,50}/i)
console.log('response snippet:', snip?snip[0]:'(none)')
await browser.close()

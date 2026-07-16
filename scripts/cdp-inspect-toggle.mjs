import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/ng/') }
await page.bringToFront(); await page.waitForTimeout(1500)
const info = await page.evaluate(() => {
  const out = { balances: [], toggleBlocks: [] }
  // all NGN amounts on the page
  for (const m of document.body.innerText.matchAll(/NGN\s*[\d,.]+/g)) out.balances.push(m[0])
  // REAL/SIM toggle region
  const btns = [...document.querySelectorAll('[class*=inside-btn], [class*=real-sim], [class*=tab]')]
    .filter(e => /^(REAL|SIM)$/i.test(e.textContent.trim()))
  for (const b of btns) out.toggleBlocks.push({ text: b.textContent.trim(), cls: b.className, parentCls: b.parentElement?.className?.slice(0,60) })
  return out
})
console.log('balances on page:', JSON.stringify([...new Set(info.balances)]))
console.log('REAL/SIM buttons:', JSON.stringify(info.toggleBlocks, null, 1))
await browser.close()

// scripts/cdp-balread.mjs — reproduce place-all-cdp's balance read, before and after a reload.
import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/ng/') }
const balNum = async () => { const m = (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/); return m ? parseFloat(m[1].replace(/,/g, '')) : NaN }
console.log('before reload:', await balNum())
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
for (const w of [2, 4, 6, 8]) {
  await page.waitForTimeout((w - (w - 2)) * 1000 + 2000)
  const b = await balNum()
  const login = await page.evaluate(() => !!document.querySelector('button.m-btn-login'))
  const bodyHead = (await page.evaluate(() => document.body.innerText)).slice(0, 120).replace(/\n/g, ' | ')
  console.log(`~${w}s → bal ${b} · loginBtn ${login} · head: ${bodyHead}`)
}
await browser.close()

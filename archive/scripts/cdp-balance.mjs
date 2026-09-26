import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000)
console.log('balance after reload:', (await page.evaluate(()=>document.body.innerText)).match(/NGN\s*([\d,.]+)/)?.[1])
await browser.close()

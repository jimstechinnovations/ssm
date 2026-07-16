import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.waitForTimeout(300)
// click Cancel on the "About to pay" dialog (div.es-dialog-btn, not a <button>)
const cancel = page.locator('.es-dialog-btn:visible, [class*=dialog-btn]:visible', { hasText: /^cancel$/i }).first()
if (await cancel.count()) { await cancel.click({ force: true }); console.log('dismissed pay dialog (Cancel)') }
else console.log('no pay dialog to dismiss')
await page.waitForTimeout(500)
console.log('balance:', (await page.evaluate(()=>document.body.innerText)).match(/NGN\s*([\d,.]+)/)?.[1])
await browser.close()

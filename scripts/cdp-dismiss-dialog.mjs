import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront()
const ok = page.locator('button:visible, span:visible', { hasText: /^OK$/i }).first()
if (await ok.count()) { await ok.click(); console.log('clicked OK') } else { console.log('no OK dialog found') }
await page.waitForTimeout(1500)
await browser.close()

// scripts/cdp-resize.mjs — resize the debug Chrome window so the betslip (Booking Code box) is on-screen.
import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => /sportybet\.com/.test(p.url())) ?? ctx.pages()[0]
const cdp = await ctx.newCDPSession(page)
const { windowId } = await cdp.send('Browser.getWindowForTarget')
await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1600, height: 1100 } })
await page.waitForTimeout(1200)
const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
console.log('viewport now:', JSON.stringify(size))
await browser.close()

import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront()
await page.locator('button.m-btn-login, button:has-text("Login")').first().click()
await page.waitForTimeout(6000)
const text = await page.evaluate(() => document.body.innerText)
console.log(text.match(/NGN\s*[\d,.]+/)?.[0] || 'no balance found')
await browser.close()

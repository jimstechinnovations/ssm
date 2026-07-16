/**
 * scripts/cdp-verify.mjs — attach to the user's REAL Chrome over CDP and PROVE the session is
 * genuine: report navigator.webdriver (should be false/undefined), the account balance, and the
 * betslip REAL/SIM state. Places nothing. This is the go/no-go test for CDP-driven placement.
 *
 * Prereq: run scripts/cdp-launch-chrome.ps1 first (Chrome Default profile on debug port 9222).
 * Run: node scripts/cdp-verify.mjs [bookingCode]
 */
import { chromium } from 'playwright'

const code = process.argv[2] // optional: load a slip to reveal the REAL/SIM toggle

let browser
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
} catch (e) {
  console.error('Could not attach to Chrome on :9222 — run scripts/cdp-launch-chrome.ps1 first.')
  console.error(e.message)
  process.exit(1)
}

const ctx = browser.contexts()[0]
// find (or open) a SportyBet tab
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded' }) }
await page.bringToFront()
await page.waitForTimeout(2500)

const webdriver = await page.evaluate(() => navigator.webdriver)
const balance = (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/)?.[1]
console.log('navigator.webdriver:', webdriver, '(false/undefined = genuine, not flagged as automation)')
console.log('account balance:', balance)

if (code) {
  const codeInput = page.locator('input[placeholder="Booking Code"]').first()
  if (await codeInput.count()) {
    await codeInput.click(); await codeInput.type(code, { delay: 110 }); await page.waitForTimeout(1000)
    const load = page.locator('[class*=betslip] >> text=/^Load$/i').first()
    if (await load.count()) { await load.click(); await page.waitForTimeout(4000) }
  }
  const toggles = await page.evaluate(() => [...document.querySelectorAll('[class*=inside-btn]')].map(b => ({ text: b.textContent.trim(), active: !/inactive/.test(b.className) })))
  console.log('betslip REAL/SIM toggle:', JSON.stringify(toggles))
  console.log('balance with slip loaded:', (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/)?.[1])
}

await browser.close() // detaches CDP; does NOT close the user's Chrome
console.log('\ndetached (your Chrome stays open).')

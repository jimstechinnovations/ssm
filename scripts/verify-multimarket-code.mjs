/**
 * scripts/verify-multimarket-code.mjs — LOAD-ONLY check of a booking code on the already-logged-in
 * debug Chrome (:9222). Clears the betslip, pastes the code, reads back leg count + total odds.
 * Does NOT type a stake and does NOT click Place Bet.
 * Run: node scripts/verify-multimarket-code.mjs <bookingCode> <expectedLegs> <expectedOdds>
 */
import { chromium } from 'playwright'

const [, , code, expectedLegs, expectedOdds] = process.argv
if (!code) { console.error('usage: node scripts/verify-multimarket-code.mjs <code> [expectedLegs] [expectedOdds]'); process.exit(1) }

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60000 }) }
await page.bringToFront()
await page.waitForTimeout(1500)

// clear any existing betslip
const removeAll = page.locator('[data-cms-key=remove_all]:visible').first()
if (await removeAll.count()) {
  await removeAll.click()
  await page.waitForTimeout(2000)
  const confirmClear = page.locator('button:visible', { hasText: /^(ok|yes|confirm|remove)$/i }).first()
  if (await confirmClear.count()) { await confirmClear.click(); await page.waitForTimeout(1500) }
}

const codeInput = page.locator('input[placeholder="Booking Code"]').first()
await codeInput.waitFor({ timeout: 15000 })
await codeInput.click()
await codeInput.type(code, { delay: 100 })
await page.waitForTimeout(1200)
await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
await page.waitForTimeout(6000)

const slipText = await page.evaluate(() => {
  const panels = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetWidth || e.offsetHeight)
  const panel = panels.sort((a, b) => b.innerText.length - a.innerText.length)[0]
  return (panel ?? document.body).innerText
})

const legCount = (slipText.match(/Over\/Under|Draw No Bet|Double Chance|Handicap|1X2|GG\/NG|Home O\/U|Away O\/U|Goal Range|Winning Margin|Correct Score|1st Half - Double Chance/g) || []).length
const siteOdds = parseFloat((slipText.match(/\bOdds\s+([\d,.]+)/i)?.[1] ?? '').replace(/,/g, ''))

console.log('===== LOAD-ONLY VERIFY (no stake entered, no bet placed) =====')
console.log(`legs on site: ${legCount}${expectedLegs ? ` (expected ${expectedLegs})` : ''}`)
console.log(`site odds: ${siteOdds}${expectedOdds ? ` (expected ~${expectedOdds})` : ''}`)
if (expectedLegs && legCount !== Number(expectedLegs)) console.log(`*** LEG COUNT MISMATCH ***`)
if (expectedOdds && Number.isFinite(siteOdds)) {
  const drift = Math.abs(siteOdds - Number(expectedOdds)) / Number(expectedOdds)
  console.log(`odds drift: ${(drift * 100).toFixed(2)}%${drift > 0.10 ? '  *** DRIFT > 10% ***' : ''}`)
}
console.log('\nfirst 1500 chars of betslip text:\n', slipText.slice(0, 1500))
await page.screenshot({ path: 'verify-multimarket.png' })
console.log('\nscreenshot: verify-multimarket.png')
await browser.close()

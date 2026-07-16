/**
 * scripts/probe-sporty-totals.mjs — after loading a booking code, dump the FULL betslip text
 * so we can see the exact "Total Odds" / "Potential Win" labels to verify against before staking.
 * Run: node scripts/probe-sporty-totals.mjs <bookingCode> <stake> <out-dir>
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const [, , code, stake = '100', outDir = '.'] = process.argv

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  viewport: { width: 1440, height: 1100 },
})).newPage()

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3_000)
  await page.fill('input[name=phone]', process.env.SPORTY_NUMBER.replace(/^\+?234/, '0'))
  await page.fill('input[name=psd]', process.env.SPORTY_PASSWORD)
  await page.click('button.m-btn-login')
  await page.waitForTimeout(6_000)

  // If the betslip already holds selections, clear it so we load EXACTLY our legs.
  // (On a fresh session it is empty and this control is hidden — hence the :visible guard.)
  const removeAll = page.locator('[data-cms-key=remove_all]:visible').first()
  if (await removeAll.count()) {
    await removeAll.click()
    await page.waitForTimeout(2_500)
    const confirmClear = page.locator('button:visible', { hasText: /^(ok|yes|confirm|remove)$/i }).first()
    if (await confirmClear.count()) { await confirmClear.click(); await page.waitForTimeout(2_000) }
    console.log('cleared existing betslip')
  }

  const codeInput = page.locator('input[placeholder="Booking Code"]').first()
  await codeInput.waitFor({ timeout: 15_000 })
  await codeInput.click()
  await codeInput.type(code, { delay: 120 })
  await page.waitForTimeout(1_200)
  await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
  await page.waitForTimeout(6_000)

  const stakeBox = page.locator('input[placeholder^="min."]').first()
  await stakeBox.click()
  await stakeBox.fill('')
  await stakeBox.type(stake, { delay: 100 })
  await page.waitForTimeout(2_500)

  const full = await page.evaluate(() => {
    const panel = document.querySelector('[class*=betslip]')
    return (panel ?? document.body).innerText
  })
  console.log('===== FULL BETSLIP TEXT =====')
  console.log(full.slice(0, 2500))

  const placeBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(e => /place bet/i.test(e.textContent || ''))
    return b ? { cls: b.className, disabled: b.hasAttribute('disabled') || /is-disabled/.test(b.className) } : null
  })
  console.log('\nPlace Bet button:', JSON.stringify(placeBtn))
  await page.screenshot({ path: `${outDir}/sp-totals.png` })
} finally {
  await browser.close()
}

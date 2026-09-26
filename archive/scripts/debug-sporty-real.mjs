/**
 * scripts/debug-sporty-real.mjs — inspect the REAL/SIM toggle, activate REAL, then place.
 * Stops immediately if the balance moves. Run: node scripts/debug-sporty-real.mjs <code> <out-dir>
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const [, , code, outDir = '.'] = process.argv

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  viewport: { width: 1440, height: 1100 },
})).newPage()

page.on('response', r => { const u = r.url(); if (/orders\/(place|inspect|create|bet)/i.test(u)) console.log('  [ORDER POST]', r.status(), u.slice(0, 80)) })
const balance = async () => (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/)?.[1]

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3_000)
  await page.fill('input[name=phone]', process.env.SPORTY_NUMBER.replace(/^\+?234/, '0'))
  await page.fill('input[name=psd]', process.env.SPORTY_PASSWORD)
  await page.click('button.m-btn-login')
  await page.waitForTimeout(7_000)
  const before = await balance()
  console.log('balance BEFORE:', before)

  const removeAll = page.locator('[data-cms-key=remove_all]:visible').first()
  if (await removeAll.count()) { await removeAll.click(); await page.waitForTimeout(2500) }
  const codeInput = page.locator('input[placeholder="Booking Code"]').first()
  await codeInput.click(); await codeInput.type(code, { delay: 120 }); await page.waitForTimeout(1200)
  await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
  await page.waitForTimeout(6000)

  // ── the REAL/SIM toggle ──
  const toggles = await page.evaluate(() => [...document.querySelectorAll('[class*=inside-btn]')]
    .map(e => ({ text: e.textContent.trim(), cls: e.className, active: !/inactive/.test(e.className) })))
  console.log('toggle state:', JSON.stringify(toggles))
  // click REAL if it isn't the active one
  const realBtn = page.locator('[class*=inside-btn]', { hasText: /^REAL$/i }).first()
  if (await realBtn.count()) {
    await realBtn.click()
    await page.waitForTimeout(1500)
    const after = await page.evaluate(() => [...document.querySelectorAll('[class*=inside-btn]')]
      .map(e => ({ text: e.textContent.trim(), active: !/inactive/.test(e.className) })))
    console.log('toggle after clicking REAL:', JSON.stringify(after))
  }

  const stakeBox = page.locator('input[placeholder^="min."]').first()
  await stakeBox.click(); await stakeBox.fill(''); await stakeBox.type('100', { delay: 100 })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${outDir}/real-ready.png` })

  console.log('--- clicking Place Bet (REAL) ---')
  await page.locator('button.af-button:visible', { hasText: /place bet/i }).first().click({ timeout: 8000 })
  for (const t of [3, 4, 5, 5]) {
    await page.waitForTimeout(t * 1000)
    for (const re of [/^(confirm|ok|continue|accept|yes|place)$/i, /accept.*odds|odds.*change/i]) {
      const b = page.locator('button:visible', { hasText: re }).first()
      if (await b.count()) { console.log('  dialog:', re.source); await b.click().catch(()=>{}); await page.waitForTimeout(3000) }
    }
    const bal = await balance()
    console.log(`  [+${t}s] balance:`, bal)
    if (bal !== before) { console.log('  *** BALANCE MOVED — placed. ***'); break }
  }
  await page.screenshot({ path: `${outDir}/real-after.png` })
  console.log('balance AFTER:', await balance())
} finally {
  await browser.close()
}

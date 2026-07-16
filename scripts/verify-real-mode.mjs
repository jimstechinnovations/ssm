/**
 * scripts/verify-real-mode.mjs — confirm the headed profile can switch SIM→REAL and that REAL
 * shows the true (small) balance. Loads a slip, forces REAL, reads both, then EXITS. Places nothing.
 * Run: node scripts/verify-real-mode.mjs <bookingCode>
 */
import { chromium } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const code = process.argv[2] ?? 'N05LKT'
const profileDir = path.join(process.cwd(), '.browser-profiles', 'sportybet')
mkdirSync(profileDir, { recursive: true })

let ctx
for (const channel of ['chrome', undefined]) {
  try { ctx = await chromium.launchPersistentContext(profileDir, { headless: false, channel, viewport: { width: 1440, height: 1000 }, args: ['--disable-blink-features=AutomationControlled'] }); break }
  catch (e) { if (channel === undefined) throw e }
}
const page = ctx.pages()[0] ?? await ctx.newPage()
const bal = async () => (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/)?.[1]
const toggles = () => page.evaluate(() => [...document.querySelectorAll('[class*=inside-btn]')].map(b => ({ text: b.textContent.trim(), active: !/inactive/.test(b.className) })))

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3_000)
  if (!/NGN\s*[\d,.]/.test(await page.evaluate(() => document.body.innerText))) {
    const pb = page.locator('input[name=phone]').first()
    if (await pb.count()) { await pb.fill(process.env.SPORTY_NUMBER.replace(/^\+?234/, '0')); await page.fill('input[name=psd]', process.env.SPORTY_PASSWORD); await page.click('button.m-btn-login'); await page.waitForTimeout(7_000) }
  }
  console.log('balance on load:', await bal())

  // Only load the code if the betslip is empty (a persisted slip already shows the toggle).
  const codeInput = page.locator('input[placeholder="Booking Code"]').first()
  if (await codeInput.count()) {
    await codeInput.click(); await codeInput.type(code, { delay: 120 }); await page.waitForTimeout(1_200)
    const loadBtn = page.locator('[class*=betslip] >> text=/^Load$/i').first()
    if (await loadBtn.count()) { await loadBtn.click(); await page.waitForTimeout(6_000) }
  } else {
    console.log('(a betslip is already loaded — testing the toggle on it)')
    await page.waitForTimeout(1_000)
  }

  console.log('toggles BEFORE:', JSON.stringify(await toggles()), '| balance:', await bal())
  const real = page.locator('[class*=inside-btn]', { hasText: /^REAL$/i }).first()
  if (await real.count()) { await real.click(); await page.waitForTimeout(2_500) }
  console.log('toggles AFTER clicking REAL:', JSON.stringify(await toggles()), '| balance:', await bal())
} finally {
  await page.waitForTimeout(1_000)
  await ctx.close()
}

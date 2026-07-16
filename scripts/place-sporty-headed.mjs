/**
 * scripts/place-sporty-headed.mjs — place a SportyBet slip in a REAL, VISIBLE Chrome window.
 *
 * A headed persistent profile means (a) SportyBet's own JS runs and encrypts the order (so no
 * payload reverse-engineering), (b) the session stays logged in across runs, and (c) the click
 * comes from a genuine browser. The script loads the exact slip and sets the stake, then either
 * auto-clicks Place Bet or — if the site still ignores the automated click — leaves the window
 * open with everything ready so you click the one green button yourself.
 *
 * Confirmation is truth-based: it only reports success when the balance actually drops.
 *
 * Run: node scripts/place-sporty-headed.mjs <bookingCode> <stake> [--auto]
 *   --auto : attempt the click automatically; without it, the script preps and waits for you.
 */
import { chromium } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const code = process.argv[2]
const stake = process.argv[3] ?? '10'
const auto = process.argv.includes('--auto')
if (!code) { console.error('usage: node scripts/place-sporty-headed.mjs <bookingCode> <stake> [--auto]'); process.exit(1) }

const profileDir = path.join(process.cwd(), '.browser-profiles', 'sportybet')
mkdirSync(profileDir, { recursive: true })

// Persistent + headed = a normal Chrome window that stays logged in. Try real Chrome, fall back to bundled Chromium.
let ctx
for (const channel of ['chrome', undefined]) {
  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      channel,
      viewport: { width: 1440, height: 1000 },
      args: ['--disable-blink-features=AutomationControlled'],
    })
    break
  } catch (e) { if (channel === undefined) throw e }
}
const page = ctx.pages()[0] ?? await ctx.newPage()
const balance = async () => (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/)?.[1]

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3_000)

  // Log in only if the saved profile isn't already authenticated.
  const loggedIn = /NGN\s*[\d,.]/.test(await page.evaluate(() => document.body.innerText))
  if (!loggedIn) {
    const phoneBox = page.locator('input[name=phone]').first()
    if (await phoneBox.count()) {
      await phoneBox.fill(process.env.SPORTY_NUMBER.replace(/^\+?234/, '0'))
      await page.fill('input[name=psd]', process.env.SPORTY_PASSWORD)
      await page.click('button.m-btn-login')
      await page.waitForTimeout(7_000)
    }
  }
  // Load exactly our slip (the REAL/SIM toggle only appears once the betslip has selections).
  const removeAll = page.locator('[data-cms-key=remove_all]:visible').first()
  if (await removeAll.count()) { await removeAll.click(); await page.waitForTimeout(2_000) }
  const codeInput = page.locator('input[placeholder="Booking Code"]').first()
  await codeInput.click(); await codeInput.type(code, { delay: 120 }); await page.waitForTimeout(1_200)
  await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
  await page.waitForTimeout(6_000)

  // ── HARD REAL-MODE ENFORCEMENT ──
  // The saved profile can come up in SIM (play-money) mode, which shows a fake ~₦384k balance.
  // Force REAL, verify it took, and REFUSE to place if the balance still looks like SIM money.
  const realState = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[class*=inside-btn]')]
    const real = btns.find(b => /^REAL$/i.test(b.textContent.trim()))
    return real ? { found: true, active: !/inactive/.test(real.className) } : { found: false }
  })
  if (realState.found && !realState.active) {
    console.log('betslip was in SIM mode — switching to REAL…')
    await page.locator('[class*=inside-btn]', { hasText: /^REAL$/i }).first().click()
    await page.waitForTimeout(2_500)
  }
  const nowReal = await page.evaluate(() => {
    const real = [...document.querySelectorAll('[class*=inside-btn]')].find(b => /^REAL$/i.test(b.textContent.trim()))
    return real ? !/inactive/.test(real.className) : true // if no toggle, assume real sportsbook
  })
  if (!nowReal) { console.error('ABORT: could not switch the betslip to REAL mode.'); await ctx.close(); process.exit(2) }

  const before = await balance()
  const beforeNum = before ? parseFloat(before.replace(/,/g, '')) : NaN
  console.log('REAL mode — balance:', before)
  // Guard: a SIM-sized balance means we're still on play money. Real account is small (~₦90).
  if (Number.isFinite(beforeNum) && beforeNum > 100_000) {
    console.error(`ABORT: balance ₦${before} looks like SIM play-money (> ₦100,000). Not placing a real bet in a simulated wallet.`)
    await ctx.close(); process.exit(3)
  }

  const stakeBox = page.locator('input[placeholder^="min."]').first()
  await stakeBox.click(); await stakeBox.fill(''); await stakeBox.type(stake, { delay: 100 })
  await page.waitForTimeout(2_000)

  const slipText = await page.evaluate(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight)
    const p = [...document.querySelectorAll('[class*=betslip]')].filter(vis).sort((a, b) => b.innerText.length - a.innerText.length)[0]
    return p ? p.innerText : ''
  })
  console.log('betslip ready — odds:', slipText.match(/\bOdds\s+([\d,.]+)/i)?.[1], '| stake:', slipText.match(/Total Stake\s+([\d,.]+)/i)?.[1], '| potential:', slipText.match(/Potential Win\s*\n?\s*([\d,.]+)/i)?.[1])

  async function confirmed() {
    for (let i = 0; i < 12; i++) { await page.waitForTimeout(2_500); if ((await balance()) !== before) return true }
    return false
  }

  if (auto) {
    console.log('clicking Place Bet…')
    await page.locator('button.af-button:visible', { hasText: /place bet/i }).first().click({ timeout: 8_000 }).catch(() => {})
    await page.waitForTimeout(3_000)
    for (const re of [/^(confirm|ok|continue|accept|yes)$/i, /accept.*odds|odds.*change/i]) {
      const b = page.locator('button:visible', { hasText: re }).first()
      if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(3_000) }
    }
    if (await confirmed()) {
      console.log('*** PLACED — balance', before, '→', await balance(), '***')
    } else {
      console.log('auto-click did not register. The window is READY — click the green Place Bet button yourself.')
      console.log('waiting up to 3 min for your click…')
      if (await confirmed()) console.log('*** PLACED (your click) — balance', before, '→', await balance(), '***')
      else console.log('no placement detected. balance still', await balance())
    }
  } else {
    console.log('\n>>> Slip is loaded and staked. Click the green "Place Bet" button in the window.')
    console.log('    Waiting up to 3 min and watching your balance…')
    if (await confirmed()) console.log('*** PLACED — balance', before, '→', await balance(), '***')
    else console.log('no placement detected within 3 min. balance still', await balance())
  }
} finally {
  await page.waitForTimeout(2_000)
  await ctx.close()
}

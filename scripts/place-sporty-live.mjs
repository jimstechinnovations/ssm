/**
 * scripts/place-sporty-live.mjs — SUPERVISED live placement of ONE PEDLA slip on SportyBet NG.
 * User-authorized (2026-07-13): one real ₦100 slip. Flow:
 *   1. POST /api/ng/orders/share → booking code for the slip's selections (no auth needed)
 *   2. Playwright: login → load booking code → VERIFY legs + odds → stake → screenshot → place
 * Aborts (with screenshots) on: leg-count mismatch, total-odds drift > 10%, missing controls.
 * Run: node scripts/place-sporty-live.mjs <book.json> <out-dir> [--no-place]
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const phone = process.env.SPORTY_NUMBER, psd = process.env.SPORTY_PASSWORD
if (!phone || !psd) { console.error('SPORTY_NUMBER / SPORTY_PASSWORD not set'); process.exit(1) }

const bookPath = process.argv[2]
const outDir = process.argv[3] ?? '.'
const noPlace = process.argv.includes('--no-place')
const data = JSON.parse(readFileSync(bookPath, 'utf8'))
const book = data.results ? data.results[0].book : data.book
const slip = book.slips[0]

// 1 ── booking code
const selections = slip.legs.map(l => ({
  eventId: `sr:match:${l.fixtureId}`,
  marketId: '18',
  specifier: `total=${l.line}`,
  outcomeId: l.side === 'Under' ? '13' : '12',
}))
const shareRes = await fetch('https://www.sportybet.com/api/ng/orders/share', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', platform: 'web' },
  body: JSON.stringify({ selections, shareType: 1 }),
})
const share = await shareRes.json()
if (share.bizCode !== 10000 || !share.data?.shareCode) {
  console.error('booking code failed:', JSON.stringify(share).slice(0, 300)); process.exit(1)
}
const code = share.data.shareCode
console.log('booking code:', code, '| legs:', selections.length, '| engine odds:', slip.combinedOdds.toFixed(2))

// 2 ── browser
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  viewport: { width: 1440, height: 1000 },
})
const page = await ctx.newPage()
const shot = (name) => page.screenshot({ path: `${outDir}/${name}.png`, fullPage: false })
const fail = async (msg, name) => { console.error('ABORT:', msg); await shot(name); await browser.close(); process.exit(2) }

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3_000)

  // login
  const local = phone.replace(/^\+?234/, '0')
  await page.fill('input[name=phone]', local)
  await page.waitForTimeout(600)
  await page.fill('input[name=psd]', psd)
  await page.waitForTimeout(600)
  await page.click('button.m-btn-login')
  await page.waitForTimeout(6_000)
  const body0 = await page.evaluate(() => document.body.innerText)
  if (!/NGN\s*[\d,.]+/.test(body0)) await fail('no balance after login', 'sp-login-fail')
  console.log('logged in, balance:', body0.match(/NGN\s*[\d,.]+/)?.[0])

  // load booking code
  const codeInput = page.locator('input[placeholder="Booking Code"]').first()
  if (!(await codeInput.count())) await fail('booking code input not found', 'sp-no-codebox')
  await codeInput.fill(code)
  await page.waitForTimeout(800)
  const loadBtn = page.locator('button, .m-btn', { hasText: /^Load$/i }).first()
  await loadBtn.click()
  await page.waitForTimeout(5_000)
  await shot('sp-betslip-loaded')

  // verify betslip
  const slipText = await page.evaluate(() => {
    const el = document.querySelector('.m-betslips, .betslip, [class*=betslip]')
    return el ? el.innerText : document.body.innerText
  })
  const legCount = (slipText.match(/Under 4\.5|Over 4\.5/g) || []).length
  console.log('betslip legs detected:', legCount)
  if (legCount < slip.legs.length) await fail(`betslip shows ${legCount} legs, expected ${slip.legs.length}`, 'sp-leg-mismatch')

  const oddsMatch = slipText.match(/Total Odds[\s:]*([\d,.]+)/i)
  const siteOdds = oddsMatch ? parseFloat(oddsMatch[1].replace(/,/g, '')) : NaN
  console.log('site total odds:', siteOdds)
  if (!Number.isFinite(siteOdds)) await fail('could not read total odds', 'sp-no-odds')
  const drift = Math.abs(siteOdds - slip.combinedOdds) / slip.combinedOdds
  if (drift > 0.10) await fail(`odds drift ${(drift * 100).toFixed(1)}% (site ${siteOdds} vs engine ${slip.combinedOdds.toFixed(2)})`, 'sp-odds-drift')

  // stake
  const stakeInput = page.locator('[class*=betslip] input[type=text], .m-betslips input').filter({ hasNot: page.locator('[placeholder="Booking Code"]') }).first()
  const stakeBox = page.locator('input[placeholder*="Stake" i], input[class*=stake i]').first()
  const target = (await stakeBox.count()) ? stakeBox : stakeInput
  if (!(await target.count())) await fail('stake input not found', 'sp-no-stake')
  await target.click()
  await target.fill(String(slip.stake))
  await page.waitForTimeout(1_500)
  await shot('sp-staked')

  const preText = await page.evaluate(() => document.body.innerText)
  const potWin = preText.match(/(Potential Win|To Win|Pot\. Win)[\s:]*(?:NGN|₦)?\s*([\d,.]+)/i)
  console.log('potential win shown:', potWin ? potWin[2] : 'not found')

  if (noPlace) { console.log('--no-place: stopping before the money click.'); await browser.close(); process.exit(0) }

  // place
  const placeBtn = page.locator('button, .m-btn', { hasText: /place bet/i }).first()
  if (!(await placeBtn.count())) await fail('Place Bet button not found', 'sp-no-place')
  await placeBtn.click()
  await page.waitForTimeout(3_000)
  await shot('sp-after-place-click')

  // possible confirm dialog
  const confirmBtn = page.locator('button, .m-btn', { hasText: /^(confirm|ok|continue)$/i }).first()
  if (await confirmBtn.count()) {
    await confirmBtn.click()
    await page.waitForTimeout(4_000)
  }
  await page.waitForTimeout(3_000)
  await shot('sp-final')
  const finalText = await page.evaluate(() => document.body.innerText.slice(0, 3000))
  const success = /success|submitted|accepted|Bet ID|ticket/i.test(finalText)
  console.log('placement outcome text says success-ish:', success)
  const insufficient = /insufficient|balance is not enough|top ?up/i.test(finalText)
  if (insufficient) console.log('NOTE: site reports insufficient balance')
} finally {
  await browser.close()
}

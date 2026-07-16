/**
 * scripts/capture-order-payload.mjs — capture the EXACT /orders/order request the SportyBet app
 * builds, WITHOUT placing (the request is aborted before it reaches the server). This gives us the
 * real payload shape to implement API placement.
 *
 * Strategy: load the slip via booking code in an authenticated session, intercept & ABORT any
 * POST to /orders/order (logging its body), then trigger placement by (a) clicking the button and
 * (b) if that fires nothing, dispatching the Vuex `betslip/placeBet` / store action directly.
 *
 * Run: node scripts/capture-order-payload.mjs <bookingCode> <out-dir>
 */
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const [, , code, outDir = '.'] = process.argv

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  viewport: { width: 1440, height: 1100 },
})
const page = await ctx.newPage()

let captured = null
// Intercept and ABORT the order POST so nothing is placed, but log the payload + headers.
await page.route(/\/orders\/order\b/, async (route) => {
  const req = route.request()
  captured = { url: req.url(), method: req.method(), headers: req.headers(), postData: req.postData() }
  console.log('\n*** CAPTURED /orders/order (aborted, no bet placed) ***')
  await route.abort('failed')
})

try {
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3_000)
  await page.fill('input[name=phone]', process.env.SPORTY_NUMBER.replace(/^\+?234/, '0'))
  await page.fill('input[name=psd]', process.env.SPORTY_PASSWORD)
  await page.click('button.m-btn-login')
  await page.waitForTimeout(7_000)

  const removeAll = page.locator('[data-cms-key=remove_all]:visible').first()
  if (await removeAll.count()) { await removeAll.click(); await page.waitForTimeout(2500) }
  const codeInput = page.locator('input[placeholder="Booking Code"]').first()
  await codeInput.click(); await codeInput.type(code, { delay: 120 }); await page.waitForTimeout(1200)
  await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
  await page.waitForTimeout(6000)
  const stakeBox = page.locator('input[placeholder^="min."]').first()
  await stakeBox.click(); await stakeBox.fill(''); await stakeBox.type('100', { delay: 100 })
  await page.waitForTimeout(2500)

  console.log('operId present:', await page.evaluate(() => Boolean(window.operId)))

  // (a) button click
  await page.locator('button.af-button:visible', { hasText: /place bet/i }).first().click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(3000)

  // (b) if nothing captured, dispatch the store action directly
  if (!captured) {
    console.log('button fired no order request — trying to dispatch the store action…')
    const dispatched = await page.evaluate(() => {
      // find a Vue root with a Vuex store
      const nodes = [document.querySelector('#app'), ...document.querySelectorAll('[data-v-app], .app, #root')]
      let store = null
      for (const el of nodes) {
        const vue = el && (el.__vue__ || el.__vue_app__)
        if (vue && vue.$store) { store = vue.$store; break }
        if (vue && vue.config && vue.config.globalProperties && vue.config.globalProperties.$store) { store = vue.config.globalProperties.$store; break }
      }
      if (!store) {
        // walk the DOM for any element exposing __vue__.$store
        const all = document.querySelectorAll('*')
        for (const el of all) { if (el.__vue__ && el.__vue__.$store) { store = el.__vue__.$store; break } }
      }
      if (!store) return { ok: false, reason: 'no vuex store found' }
      try {
        store.dispatch('betslip/placeBet', { payAmount: 100 })
        return { ok: true }
      } catch (e) { return { ok: false, reason: String(e).slice(0, 120) } }
    })
    console.log('dispatch result:', JSON.stringify(dispatched))
    await page.waitForTimeout(4000)
  }

  if (captured) {
    writeFileSync(`${outDir}/order-capture.json`, JSON.stringify(captured, null, 2))
    console.log('headers:', JSON.stringify(captured.headers, null, 1))
    console.log('\npostData:\n', captured.postData)
    console.log('\nsaved →', `${outDir}/order-capture.json`)
  } else {
    console.log('\nNo /orders/order request was produced by either method.')
  }
} finally {
  await browser.close()
}

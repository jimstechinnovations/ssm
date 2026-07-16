// Connect to the debug Chrome, ensure a SportyBet page, auto-login if needed, report state.
import { chromium } from 'playwright'
import { readFileSync, existsSync } from 'node:fs'

if (existsSync('.env')) for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) {
  page = ctx.pages()[0] ?? await ctx.newPage()
  await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60000 })
}
await page.waitForTimeout(4000)

const balNum = async () => { const m = (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/); return m ? parseFloat(m[1].replace(/,/g, '')) : NaN }

let bal = await balNum()
if (Number.isNaN(bal)) {
  const phone = process.env.SPORTY_NUMBER, psd = process.env.SPORTY_PASSWORD
  console.log('not logged in — logging in with env credentials…')
  const pb = page.locator('input[name=phone]').first()
  if (await pb.count()) {
    await pb.fill(phone.replace(/^\+?234/, '0'))
    await page.fill('input[name=psd]', psd)
    await page.locator('button.m-btn-login').first().click()
    await page.waitForTimeout(8000)
    bal = await balNum()
  } else {
    console.log('login form not found on page — url:', page.url())
  }
}

const toggle = await page.evaluate(() => {
  const l = document.querySelector('[data-op=switch-box-left]')
  const s = document.querySelector('[data-op=switch-box-right]')
  if (!l && !s) return 'no-toggle-visible'
  return /show-highlight/.test(l?.className || '') ? 'REAL' : /show-highlight/.test(s?.className || '') ? 'SIM' : 'unknown'
})

console.log('url:', page.url())
console.log('balance:', Number.isNaN(bal) ? 'UNREADABLE (login failed?)' : '₦' + bal.toLocaleString())
console.log('mode toggle:', toggle)
await browser.close()

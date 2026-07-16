// scripts/cdp-login.mjs — log the debug Chrome into SportyBet (env creds), report state + screenshot.
import { chromium } from 'playwright'
import { readFileSync, existsSync } from 'node:fs'

if (existsSync('.env')) for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const shot = process.argv[2]

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60000 }) }
await page.bringToFront()
await page.waitForTimeout(2000)

// logged-in signal: an account/balance header area (not the betslip, which also shows NGN amounts)
const loggedIn = () => page.evaluate(() => {
  const t = document.body.innerText
  return /my account|deposit|withdraw/i.test(t) && !document.querySelector('button.m-btn-login')
})

if (await loggedIn()) {
  console.log('already logged in')
} else {
  const phone = process.env.SPORTY_NUMBER.replace(/^\+?234/, '0')
  const pb = page.locator('input[name=phone]').first()
  await pb.click({ clickCount: 3 }); await pb.fill(''); await pb.type(phone, { delay: 60 })
  const pw = page.locator('input[name=psd]').first()
  await pw.click({ clickCount: 3 }); await pw.fill(''); await pw.type(process.env.SPORTY_PASSWORD, { delay: 60 })
  await page.waitForTimeout(400)
  // click Login via real mouse (the SPA can ignore synthetic .click())
  const btn = page.locator('button.m-btn-login, button:has-text("Login")').first()
  const b = await btn.boundingBox()
  if (b) { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 }); await page.mouse.down(); await page.waitForTimeout(70); await page.mouse.up() }
  else await btn.click().catch(() => {})
  await page.waitForTimeout(9000)
}

const state = await page.evaluate(() => {
  const t = document.body.innerText
  const hasLoginBtn = !!document.querySelector('button.m-btn-login')
  const ngn = t.match(/NGN\s*([\d,.]+)/)?.[1] ?? null
  const acct = /my account|deposit|withdraw/i.test(t)
  const err = t.match(/incorrect|invalid|blocked|too many|verify|captcha/i)?.[0] ?? null
  return { hasLoginBtn, ngn, acct, err }
})
console.log('state:', JSON.stringify(state))
if (shot) { await page.screenshot({ path: shot }); console.log('shot:', shot) }
await browser.close()

// scripts/cdp-state.mjs — precise SportyBet state: header balance (real account area), login, toggle.
import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { page = await ctx.newPage(); await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60000 }) }
await page.waitForTimeout(3500)
const state = await page.evaluate(() => {
  const vis = (e) => e && (e.offsetWidth || e.offsetHeight)
  const header = [...document.querySelectorAll('header, [class*=header], [class*=top-bar]')].filter(vis)
  const headerText = header.map(h => h.innerText).join(' ')
  const bal = headerText.match(/NGN\s*([\d,.]+)/)?.[1] ?? null
  const loginVisible = vis(document.querySelector('button.m-btn-login'))
  const acct = /my account|deposit|bet history/i.test(headerText)
  const l = document.querySelector('[data-op=switch-box-left]'), s = document.querySelector('[data-op=switch-box-right]')
  const toggle = (!l && !s) ? 'none' : /show-highlight/.test(l?.className || '') ? 'REAL' : /show-highlight/.test(s?.className || '') ? 'SIM' : 'unknown'
  const betslipCount = document.querySelector('[class*=betslip] [class*=count], [class*=bets-count]')?.textContent?.trim() ?? null
  return { bal, loginVisible, acct, toggle, betslipCount, url: location.href }
})
console.log(JSON.stringify(state, null, 1))
await browser.close()

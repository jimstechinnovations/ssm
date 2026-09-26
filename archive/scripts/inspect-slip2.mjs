import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.waitForTimeout(500)
const bs = await page.evaluate(() => {
  const vis = e => e && (e.offsetHeight)
  const p = [...document.querySelectorAll('[class*=betslip]')].filter(vis).sort((a,b)=>b.innerText.length-a.innerText.length)[0]
  const body = document.body.innerText
  // Place Bet button state
  const pb = [...document.querySelectorAll('button,[class*=btn],[class*=place]')].find(e => /place bet/i.test(e.textContent||'') && (e.offsetWidth||e.offsetHeight))
  return {
    betslipText: p ? p.innerText.slice(0, 500) : '(none)',
    placeBtnDisabled: pb ? (pb.hasAttribute('disabled') || /disabled|is-disabled|inactive/.test(pb.className||'')) : 'not found',
    placeBtnClass: pb ? (pb.className||'').toString().slice(0,50) : '',
    hasOddsChange: /odds (have )?changed|accept|has changed|price change/i.test(body),
    hasSuspended: /suspend|unavailable|not available|closed|invalid|removed/i.test(body),
  }
})
console.log(JSON.stringify(bs, null, 1))
await browser.close()

import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
await page.bringToFront()
await page.waitForTimeout(800)
const info = await page.evaluate(() => {
  const panels = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetWidth || e.offsetHeight)
  const panel = panels.sort((a, b) => b.innerText.length - a.innerText.length)[0]
  return (panel ?? document.body).innerText
})
console.log(info)

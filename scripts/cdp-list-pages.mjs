import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const pages = ctx.pages()
console.log(`${pages.length} pages open:`)
for (const p of pages) console.log(' -', p.url())
await browser.close()

/**
 * scripts/cdp-place-multimarket.mjs — place the CURRENTLY LOADED betslip on the debug Chrome (:9222)
 * at a given stake. Based on scripts/cdp-place.mjs, but the balance-size SIM heuristic (`before<=1000`)
 * is replaced with an explicit user confirmation (recorded in-conversation) since this account's real
 * balance is >1000. Truth-confirmed by balance drop AND Bet History — never page-text alone
 * (pedla_v1.md §4a: a placement is only real when the BOOKMAKER says so).
 * Run: node scripts/cdp-place-multimarket.mjs <stake>
 */
import { chromium } from 'playwright'
const stake = process.argv[2] ?? '1000'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
if (!page) { console.error('no SportyBet tab'); process.exit(1) }
await page.bringToFront(); await page.waitForTimeout(1200)

const bal = async () => { const m = (await page.evaluate(() => document.body.innerText)).match(/NGN\s*([\d,.]+)/); return m ? parseFloat(m[1].replace(/,/g, '')) : NaN }

const before = await bal()
console.log('balance before:', before)
if (!Number.isFinite(before)) { console.error('ABORT: could not read balance'); await browser.close(); process.exit(2) }
if (before < Number(stake)) { console.error(`ABORT: balance ₦${before} < stake ₦${stake}`); await browser.close(); process.exit(3) }

// ── set stake ──
const stakeBox = page.locator('input[placeholder^="min."]').first()
if (!(await stakeBox.count())) { console.error('ABORT: stake box not found'); await browser.close(); process.exit(4) }
await stakeBox.click(); await stakeBox.fill(''); await stakeBox.type(String(stake), { delay: 90 })
await page.waitForTimeout(1500)
const slipText = await page.evaluate(() => { const p = [...document.querySelectorAll('[class*=betslip]')].filter(e => e.offsetHeight).sort((a, b) => b.innerText.length - a.innerText.length)[0]; return p ? p.innerText : '' })
const siteStake = parseFloat((slipText.match(/Total Stake\s+([\d,.]+)/i)?.[1] || '0').replace(/,/g, ''))
const siteOdds = slipText.match(/\bOdds\s+([\d,.]+)/i)?.[1]
const potential = slipText.match(/Potential Win\s*\n?\s*([\d,.]+)/i)?.[1]
console.log('betslip stake/odds:', siteStake, '/', siteOdds, '| potential win:', potential)
if (siteStake !== Number(stake)) { console.error('ABORT: stake did not set to', stake, '(site shows', siteStake, ')'); await browser.close(); process.exit(5) }

// ── place: human-like mouse move + click (synthetic .click() is ignored by this SPA) ──
const place = page.locator('button.af-button:visible, [class*=place]', { hasText: /place bet/i }).first()
const box = await place.boundingBox()
if (!box) { console.error('ABORT: Place Bet not found'); await browser.close(); process.exit(6) }
if (/is-disabled/.test((await place.getAttribute('class')) ?? '')) { console.error('ABORT: Place Bet is disabled'); await browser.close(); process.exit(7) }
await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2 + 12, { steps: 10 }); await page.waitForTimeout(180)
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 }); await page.waitForTimeout(120)
await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up()
console.log('clicked Place Bet')
await page.waitForTimeout(3000)
for (const re of [/^(confirm|ok|continue|accept|yes)$/i, /accept.*odds|odds.*change/i]) {
  const b = page.locator('button:visible', { hasText: re }).first()
  if (await b.count()) { console.log('confirm dialog:', re.source); await b.click().catch(() => { }); await page.waitForTimeout(3000) }
}

// ── truth-confirm #1: balance must drop by ~stake ──
let after = before
for (let i = 0; i < 10; i++) { await page.waitForTimeout(2500); after = await bal(); if (Math.abs((before - after) - Number(stake)) <= 0.5) break }
const droppedByStake = Math.abs((before - after) - Number(stake)) <= 0.5
console.log('balance after:', after, '| dropped:', (before - after).toFixed(2))

// ── truth-confirm #2: bet must appear in Bet History ──
await page.goto('https://www.sportybet.com/ng/my_accounts/bet_history/sport_bets', { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(7000)
const historyText = await page.evaluate(() => document.body.innerText)
const inHistory = !/No Bets Available/i.test(historyText) && /CF Montreal|Ajax|Molde/i.test(historyText)
console.log('found in Bet History:', inHistory)

if (droppedByStake && inHistory) console.log(`*** REAL BET PLACED & CONFIRMED (balance+history) — ₦${stake} deducted (${before} -> ${after}) ***`)
else if (droppedByStake) console.log(`*** balance dropped by ₦${stake} but NOT yet visible in Bet History (may lag) — recheck shortly ***`)
else console.log(`NOT confirmed — balance did not drop by ₦${stake}. Check the window / Bet History manually before assuming anything was placed.`)
await browser.close()

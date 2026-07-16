// lib/placement/place-sportybet.ts
// LIVE SportyBet Nigeria slip placement, with TRUTH-BASED confirmation.
//
// Verified flow (supervised, 2026-07-13):
//   1. POST /api/ng/orders/share (public, no auth) → booking code for the slip's selections.
//      The code is kept on the receipt: a human can paste it into any SportyBet session and see
//      the exact same slip — that's our audit trail between engine and bookmaker.
//   2. Playwright: login (input[name=phone] / input[name=psd] / button.m-btn-login)
//      → clear betslip → paste code → Load → verify leg count + the SITE's own total odds
//      → type stake → Place Bet → handle confirm dialog
//   3. CONFIRM AGAINST THE SITE, not the page copy: the balance must drop by the stake and/or
//      the bet must appear in Bet History with an id. (A loose text regex once reported a
//      placement that never happened — see receipt.ts.)
//
// Aborts (throw → job failed, never retried): login failure, leg mismatch, odds drift > 10%,
// stake mismatch, disabled Place Bet, insufficient balance, or unconfirmed placement.

import 'server-only'
import { chromium, type Page } from 'playwright'
import type { PedlasSlip } from '../pedlas/types'
import type { PlacementJob } from './queue'
import { parseMoney, balanceConfirms, type PlacementReceipt } from './receipt'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** Create a SportyBet booking code for a PEDLA slip (public API — no auth needed). */
export async function sportybetBookingCode(slip: PedlasSlip): Promise<string> {
  const selections = slip.legs.map(l => ({
    eventId: `sr:match:${l.fixtureId}`,
    marketId: '18',
    specifier: `total=${l.line}`,
    outcomeId: l.side === 'Under' ? '13' : '12',
  }))
  const res = await fetch('https://www.sportybet.com/api/ng/orders/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, platform: 'web' },
    body: JSON.stringify({ selections, shareType: 1 }),
  })
  const json = (await res.json()) as { bizCode?: number; data?: { shareCode?: string } }
  if (json.bizCode !== 10000 || !json.data?.shareCode) {
    throw new Error(`SportyBet booking code failed (bizCode ${json.bizCode})`)
  }
  return json.data.shareCode
}

/** The visible betslip panel's text (the site renders hidden duplicates for mobile). */
function betslipText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const visible = (e: Element) => {
      const h = e as HTMLElement
      return !!(h.offsetWidth || h.offsetHeight)
    }
    const panel = [...document.querySelectorAll('[class*=betslip]')]
      .filter(visible)
      .sort((a, b) => (b as HTMLElement).innerText.length - (a as HTMLElement).innerText.length)[0]
    return panel ? (panel as HTMLElement).innerText : document.body.innerText
  })
}

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText)

/** Read the account balance from the header. */
async function readBalance(page: Page): Promise<number | undefined> {
  return parseMoney(await bodyText(page))
}

/** Open Bet History and look for this slip; returns the bet id if the SITE shows the bet. */
async function findBetInHistory(page: Page, slip: PedlasSlip): Promise<{ found: boolean; betId?: string; text: string }> {
  await page.goto('https://www.sportybet.com/ng/my_accounts/bet_history/sport_bets', {
    waitUntil: 'domcontentloaded', timeout: 45_000,
  })
  await page.waitForTimeout(7_000)
  const text = await bodyText(page)
  if (/No Bets Available/i.test(text)) return { found: false, text }

  // A real entry shows our teams; require at least one leg's home team to appear.
  const anyTeam = slip.legs.some(l => {
    const home = l.game.split(' vs ')[0]?.trim()
    return home && text.includes(home)
  })
  const betId = text.match(/(?:Bet ID|Ticket ID|ID)[:\s]*([A-Z0-9-]{6,})/i)?.[1]
  return { found: anyTeam, betId, text }
}

export async function placeSportybetSlipLive(_job: PlacementJob, slip: PedlasSlip): Promise<PlacementReceipt> {
  const phone = process.env.SPORTY_NUMBER
  const psd = process.env.SPORTY_PASSWORD
  if (!phone || !psd) throw new Error('SPORTY_NUMBER / SPORTY_PASSWORD env vars are not set.')

  const bookingCode = await sportybetBookingCode(slip)

  const browser = await chromium.launch({ headless: true })
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 1000 } })
    const page = await ctx.newPage()
    await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(3_000)

    // ── login ──
    await page.fill('input[name=phone]', phone.replace(/^\+?234/, '0'))
    await page.waitForTimeout(600)
    await page.fill('input[name=psd]', psd)
    await page.waitForTimeout(600)
    await page.click('button.m-btn-login')
    await page.waitForTimeout(7_000)

    const balanceBefore = await readBalance(page)
    if (balanceBefore == null) throw new Error('SportyBet login failed (no balance visible)')
    if (balanceBefore < slip.stake) {
      throw new Error(`insufficient balance: ₦${balanceBefore} < stake ₦${slip.stake}`)
    }

    // ── load exactly our legs ──
    const removeAll = page.locator('[data-cms-key=remove_all]:visible').first()
    if (await removeAll.count()) {
      await removeAll.click()
      await page.waitForTimeout(2_000)
      const confirmClear = page.locator('button:visible', { hasText: /^(ok|yes|confirm|remove)$/i }).first()
      if (await confirmClear.count()) { await confirmClear.click(); await page.waitForTimeout(1_500) }
    }

    const codeInput = page.locator('input[placeholder="Booking Code"]').first()
    await codeInput.waitFor({ timeout: 15_000 })
    await codeInput.click()
    await codeInput.type(bookingCode, { delay: 120 })   // real keystrokes — the SPA ignores raw fill()
    await page.waitForTimeout(1_200)
    await page.locator('[class*=betslip] >> text=/^Load$/i').first().click()
    await page.waitForTimeout(6_000)

    const loadedLegs = ((await betslipText(page)).match(/Over\/Under/g) || []).length
    if (loadedLegs !== slip.legs.length) {
      throw new Error(`betslip shows ${loadedLegs} legs, expected ${slip.legs.length}`)
    }

    // ── stake, then check the SITE's own numbers before committing ──
    const stakeBox = page.locator('input[placeholder^="min."]').first()
    if (!(await stakeBox.count())) throw new Error('stake input not found')
    await stakeBox.click()
    await stakeBox.fill('')
    await stakeBox.type(String(slip.stake), { delay: 100 })
    await page.waitForTimeout(2_500)

    const slipText = await betslipText(page)
    const siteOdds = parseFloat((slipText.match(/\bOdds\s+([\d,.]+)/i)?.[1] ?? '').replace(/,/g, ''))
    if (!Number.isFinite(siteOdds)) throw new Error('could not read total odds from the betslip')
    const drift = Math.abs(siteOdds - slip.combinedOdds) / slip.combinedOdds
    if (drift > 0.10) {
      throw new Error(`odds drift ${(drift * 100).toFixed(1)}% — engine ${slip.combinedOdds.toFixed(2)} vs site ${siteOdds}`)
    }
    const siteStake = parseFloat((slipText.match(/Total Stake\s+([\d,.]+)/i)?.[1] ?? '').replace(/,/g, ''))
    if (!Number.isFinite(siteStake) || Math.abs(siteStake - slip.stake) > 0.5) {
      throw new Error(`stake mismatch — engine ₦${slip.stake} vs site ₦${siteStake}`)
    }
    const sitePotentialWin = parseFloat((slipText.match(/Potential Win\s*\n?\s*([\d,.]+)/i)?.[1] ?? '').replace(/,/g, ''))

    // ── place ──
    const placeBtn = page.locator('button.af-button:visible', { hasText: /place bet/i }).first()
    if (!(await placeBtn.count())) throw new Error('Place Bet button not found')
    if (/is-disabled/.test((await placeBtn.getAttribute('class')) ?? '')) {
      throw new Error('Place Bet is disabled (balance or selection invalid)')
    }
    await placeBtn.click()
    await page.waitForTimeout(4_000)

    // accept-odds-change / confirm dialogs, if any
    for (const label of [/^(confirm|ok|continue|accept|yes)$/i, /accept.*odds|odds.*changed/i]) {
      const btn = page.locator('button:visible', { hasText: label }).first()
      if (await btn.count()) { await btn.click(); await page.waitForTimeout(4_000) }
    }
    await page.waitForTimeout(4_000)

    if (/insufficient|balance is not enough|top ?up/i.test(await bodyText(page))) {
      throw new Error('SportyBet reports insufficient balance')
    }

    // ── CONFIRM against the site (the whole point) ──
    // 1) balance: poll a few times, the header can lag the placement
    let balanceAfter: number | undefined
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(2_500)
      balanceAfter = await readBalance(page)
      if (balanceConfirms(balanceBefore, balanceAfter, slip.stake)) break
    }
    const byBalance = balanceConfirms(balanceBefore, balanceAfter, slip.stake)

    // 2) bet history: the bet must actually be listed
    const history = await findBetInHistory(page, slip)

    const confirmedBy: PlacementReceipt['confirmedBy'] =
      byBalance && history.found ? 'balance+history'
      : byBalance ? 'balance'
      : history.found ? 'history'
      : 'none'

    const receipt: PlacementReceipt = {
      confirmed: confirmedBy !== 'none',
      confirmedBy,
      bookingCode,
      betId: history.betId,
      balanceBefore,
      balanceAfter,
      siteOdds,
      sitePotentialWin: Number.isFinite(sitePotentialWin) ? sitePotentialWin : undefined,
    }

    if (!receipt.confirmed) {
      receipt.detail =
        `NOT placed: balance unchanged (₦${balanceBefore} → ₦${balanceAfter}) and the bet is not in ` +
        `Bet History. Booking code ${bookingCode} still reproduces the slip if you want to place it by hand.`
      throw Object.assign(new Error(receipt.detail), { receipt })
    }
    return receipt
  } finally {
    await browser.close()
  }
}

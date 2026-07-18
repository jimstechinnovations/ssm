// lib/placement/browser.ts
// Server-side control of the local debug Chrome (:9222) so the UI — not the CLI — drives it.
// Launch, status (up / logged-in / balance / REAL-or-SIM). All best-effort; never throws to the route.

import 'server-only'
import { spawn } from 'node:child_process'

const CDP = 'http://127.0.0.1:9222/json/version'
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Is the debug Chrome reachable on :9222? */
export async function cdpUp(): Promise<boolean> {
  try { const r = await fetch(CDP, { signal: AbortSignal.timeout(2500) }); return r.ok } catch { return false }
}

/** Launch the debug Chrome (cdp-launch-chrome.ps1) if it isn't already up; wait for :9222. */
export async function launchBrowser(mode: 'dedicated' | 'default' = 'dedicated'): Promise<{ up: boolean; started: boolean }> {
  if (await cdpUp()) return { up: true, started: false }
  spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/cdp-launch-chrome.ps1', '-Mode', mode],
    { stdio: 'ignore', detached: true }).unref()
  for (let i = 0; i < 20; i++) { await sleep(1500); if (await cdpUp()) return { up: true, started: true } }
  return { up: false, started: true }
}

export interface BrowserStatus {
  up: boolean
  loggedIn?: boolean
  balance?: number | null
  mode?: 'REAL' | 'SIM' | 'unknown'
}

/**
 * One-click readiness for LIVE placement: launch Chrome if down → open SportyBet → log in (env creds)
 * → flip the betslip to REAL → read the balance. Returns the resulting status + a step log so the UI
 * can show exactly what happened. Best-effort and never throws.
 */
export async function prepareBrowser(): Promise<BrowserStatus & { steps: string[] }> {
  const steps: string[] = []
  const l = await launchBrowser('dedicated')
  steps.push(l.up ? (l.started ? 'launched Chrome' : 'Chrome already up') : 'launch failed')
  if (!l.up) return { up: false, steps }

  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.connectOverCDP(CDP)
    try {
      const ctx = browser.contexts()[0]
      let page = ctx.pages().find(p => /sportybet\.com/.test(p.url())) ?? ctx.pages()[0]
      if (!page) page = await ctx.newPage()
      if (!/sportybet\.com/.test(page.url())) await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
      await page.waitForTimeout(3000)

      // reliable logged-in check: account links present AND no VISIBLE login form
      const isLoggedIn = () => page!.evaluate(() => {
        const pb = document.querySelector('input[name=phone]') as HTMLElement | null
        return /Deposit|Bet History|My Account/i.test(document.body.innerText) && !(pb && (pb.offsetWidth || pb.offsetHeight))
      })
      if (await isLoggedIn()) {
        steps.push('already logged in')
      } else {
        const phone = process.env.SPORTY_NUMBER, psd = process.env.SPORTY_PASSWORD
        const pb = page.locator('input[name=phone]:visible').first()
        if (phone && psd && await pb.count()) {
          await pb.fill(phone.replace(/^\+?234/, '0')).catch(() => {})
          await page.fill('input[name=psd]:visible', psd).catch(() => {})
          await page.locator('button.m-btn-login:visible').first().click().catch(() => {})
          await page.waitForTimeout(8000)
          steps.push(await isLoggedIn() ? 'logged in' : 'login failed — log in once in the Chrome window (OTP/captcha?)')
        } else steps.push('not logged in — log in once in the Chrome window')
      }

      // Switch to REAL only if currently SIM — clicking blindly could toggle a REAL account to SIM.
      const flipped = await page.evaluate(() => {
        const l = document.querySelector('[data-op=switch-box-left]')   // REAL
        const s = document.querySelector('[data-op=switch-box-right]')  // SIM
        if (!l && !s) return 'no toggle visible (account mode unchanged)'
        const mode = /show-highlight/.test(l?.className || '') ? 'REAL' : /show-highlight/.test(s?.className || '') ? 'SIM' : 'unknown'
        if (mode === 'SIM' && l) { ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => l.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))); return 'switched SIM→REAL' }
        return `already ${mode}`
      })
      steps.push(flipped)
      await page.waitForTimeout(1200)
    } finally { await browser.close() }
  } catch (e) { steps.push('prep error: ' + (e instanceof Error ? e.message.slice(0, 80) : 'unknown')) }

  const st = await browserStatus()
  return { ...st, steps }
}

/** Deeper status: connect over CDP and read the balance + REAL/SIM toggle from the EXISTING SportyBet
 *  tab. READ-ONLY and non-disruptive — it never navigates the browser or steals focus (doing so on a
 *  status poll made Chrome jump to SportyBet and looked like a placement starting). If no SportyBet tab
 *  is open it honestly reports unknown; use "Prepare browser" to open/log in. */
export async function browserStatus(): Promise<BrowserStatus> {
  if (!(await cdpUp())) return { up: false }
  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.connectOverCDP(CDP)
    try {
      const ctx = browser.contexts()[0]
      if (!ctx) return { up: true, loggedIn: false }
      const page = ctx.pages().find(p => /sportybet\.com/.test(p.url()))
      if (!page) return { up: true, loggedIn: false, mode: 'unknown' }   // don't navigate — non-disruptive
      // Read-only wait for header hydration (no bringToFront / no navigate) to avoid a stale snapshot.
      await page.waitForFunction(() => /Deposit|Bet History|My Account|NGN\s*[\d,.]/i.test(document.body.innerText), { timeout: 3500 }).catch(() => {})
      const info = await page.evaluate(() => {
        const t = document.body.innerText
        const pb = document.querySelector('input[name=phone]') as HTMLElement | null
        const loginVisible = !!(pb && (pb.offsetWidth || pb.offsetHeight))
        const loggedIn = /Deposit|Bet History|My Account/i.test(t) && !loginVisible
        const bal = loggedIn ? (t.match(/NGN\s*([\d,.]+)/)?.[1] ?? null) : null   // header balance only when logged in
        const l = document.querySelector('[data-op=switch-box-left]'), s = document.querySelector('[data-op=switch-box-right]')
        const mode = (!l && !s) ? 'unknown' : /show-highlight/.test(l?.className || '') ? 'REAL' : /show-highlight/.test(s?.className || '') ? 'SIM' : 'unknown'
        return { loggedIn, bal, mode }
      }).catch(() => ({ loggedIn: false, bal: null as string | null, mode: 'unknown' as const }))
      const balance = info.bal ? parseFloat(info.bal.replace(/,/g, '')) : null
      // The REAL/SIM toggle only shows in the betslip; on other views it's 'unknown'. When logged in
      // with a balance, infer from size (SIM wallets are large play-money; >₦100k = SIM, else REAL).
      let mode = info.mode as BrowserStatus['mode']
      if (mode === 'unknown' && info.loggedIn && balance != null) mode = balance > 100_000 ? 'SIM' : 'REAL'
      return { up: true, loggedIn: info.loggedIn, balance, mode }
    } finally { await browser.close() }
  } catch { return { up: true } }
}

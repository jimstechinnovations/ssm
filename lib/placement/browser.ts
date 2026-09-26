// lib/placement/browser.ts
// Server-side control of the local debug Chromes so the UI — not the CLI — drives them.
// Launch, status (up / logged-in / balance / REAL-or-SIM). All best-effort; never throws to the route.
// One PC can run several placement windows: :9222 (profile .chrome-bot) is the main one, and each extra
// window gets the next port with its own profile (.chrome-bot-<port>) — so each has its OWN betslip.

import 'server-only'
import { spawn } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'

export const MAIN_PORT = 9222
/** Ports of the first n placement windows on this PC: 9222, 9223, … */
export const placementPorts = (n: number) => Array.from({ length: n }, (_, i) => MAIN_PORT + i)
const cdpBase = (port: number) => `http://127.0.0.1:${port}`
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Is the debug Chrome on this port reachable? */
export async function cdpUp(port = MAIN_PORT): Promise<boolean> {
  try { const r = await fetch(`${cdpBase(port)}/json/version`, { signal: AbortSignal.timeout(2500) }); return r.ok } catch { return false }
}

/** Launch the debug Chrome for this port (cdp-launch-chrome.ps1) if it isn't already up; wait for it. */
export async function launchBrowser(mode: 'dedicated' | 'default' = 'dedicated', port = MAIN_PORT): Promise<{ up: boolean; started: boolean }> {
  if (await cdpUp(port)) return { up: true, started: false }
  // NOT detached: on Windows a detached PowerShell gets its own console and the script silently never ran
  // (verified 2026-09-25). The script's own Start-Process already detaches Chrome, and the script exits by
  // itself once the port is up, so a plain child is correct.
  spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/cdp-launch-chrome.ps1', '-Mode', mode, '-Port', String(port)],
    { stdio: 'ignore', windowsHide: true }).on('error', () => { /* reported via the port check below */ })
  for (let i = 0; i < 20; i++) { await sleep(1500); if (await cdpUp(port)) return { up: true, started: true } }
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
export async function prepareBrowser(port = MAIN_PORT): Promise<BrowserStatus & { steps: string[] }> {
  const steps: string[] = []
  const l = await launchBrowser('dedicated', port)
  steps.push(l.up ? (l.started ? 'launched Chrome' : 'Chrome already up') : 'launch failed')
  if (!l.up) return { up: false, steps }

  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.connectOverCDP(cdpBase(port))
    try {
      const ctx = browser.contexts()[0]
      // An extra window has its own profile, so it logs in with its OWN session (the .env login below).
      // Copying the main window's cookies was tried and doesn't log in (part of the login lives in local
      // storage), and sharing one refresh token between two browsers risks logging the main window out.
      let page = ctx.pages().find(p => /sportybet\.com/.test(p.url())) ?? ctx.pages()[0]
      if (!page) page = await ctx.newPage()
      if (await widenWindow(ctx, page)) steps.push('widened the window so the header balance shows')
      if (!/sportybet\.com/.test(page.url())) await page.goto('https://www.sportybet.com/ng/', { waitUntil: 'commit', timeout: 60_000 }).catch(() => {})
      // wait for the header to render (logged in → Deposit/NGN, logged out → the login form)
      await page.waitForFunction(() => /Deposit|Bet History|My Account|Login/i.test(document.body?.innerText ?? ''), { timeout: 30_000 }).catch(() => {})
      await page.waitForTimeout(1500)

      // reliable logged-in check: account links present AND no VISIBLE login form
      const isLoggedIn = () => page!.evaluate(() => {
        const pb = document.querySelector('input[name=phone]') as HTMLElement | null
        return /Deposit|Bet History|My Account/i.test(document.body?.innerText ?? '') && !(pb && (pb.offsetWidth || pb.offsetHeight))
      }).catch(() => false)
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

      // DO NOT auto-toggle REAL/SIM. The toggle's DOM can't be read reliably (the highlight class
      // moved), and a wrong guess FLIPS a REAL account to SIM — worse than doing nothing. Report the
      // best-effort mode only; the operator sets REAL in the window if needed (they can see it).
      const modeSeen = await page.evaluate(() => {
        const l = document.querySelector('[data-op=switch-box-left]'), s = document.querySelector('[data-op=switch-box-right]')
        if (!l && !s) return 'toggle not visible'
        return /show-highlight/.test(l?.className || '') ? 'REAL?' : /show-highlight/.test(s?.className || '') ? 'SIM?' : 'unknown'
      })
      steps.push(`mode seen: ${modeSeen} — NOT auto-toggled (set REAL in the window if needed)`)
      // A picture of the REAL/SIM toggle for the operator (the class read above is unreliable; the image isn't).
      if (await shotToggle(page, port)) steps.push('saved a screenshot of the REAL/SIM toggle')
      await page.waitForTimeout(500)
    } finally { await browser.close() }
  } catch (e) { steps.push('prep error: ' + (e instanceof Error ? e.message.slice(0, 80) : 'unknown')) }

  const st = await browserStatus(port)
  return { ...st, steps }
}

/** Deeper status: connect over CDP and read the balance + REAL/SIM toggle from the EXISTING SportyBet
 *  tab. READ-ONLY and non-disruptive — it never navigates the browser or steals focus (doing so on a
 *  status poll made Chrome jump to SportyBet and looked like a placement starting). If no SportyBet tab
 *  is open it honestly reports unknown; use "Prepare browser" to open/log in. */
export async function browserStatus(port = MAIN_PORT): Promise<BrowserStatus> {
  if (!(await cdpUp(port))) return { up: false }
  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.connectOverCDP(cdpBase(port))
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
        // the HEADER balance element only — "first NGN on the page" read a big-wins widget in a narrow window
        const bal = loggedIn ? ((document.querySelector('#j_balance, .m-balance')?.textContent ?? '').match(/NGN\s*([\d,.]+)/)?.[1] ?? null) : null
        const l = document.querySelector('[data-op=switch-box-left]'), s = document.querySelector('[data-op=switch-box-right]')
        const mode = (!l && !s) ? 'unknown' : /show-highlight/.test(l?.className || '') ? 'REAL' : /show-highlight/.test(s?.className || '') ? 'SIM' : 'unknown'
        return { loggedIn, bal, mode }
      }).catch(() => ({ loggedIn: false, bal: null as string | null, mode: 'unknown' as const }))
      const balance = info.bal ? parseFloat(info.bal.replace(/,/g, '')) : null
      // The REAL/SIM toggle CLASS read is UNRELIABLE — proven 2026-07-20: it reported SIM on a REAL
      // ₦29.29 account (the placer then confirmed REAL via a ₦20 balance-drop). So when logged in with a
      // known balance, trust the BALANCE as the mode signal (SIM play-money is large; REAL is small),
      // not the toggle class. This is a best-effort GATE only — the ground truth is still the per-slip
      // balance-drop confirmation (1 worker) before real money moves. Toggle read is a last-resort
      // fallback when the balance is unknown.
      // No readable balance → 'unknown', NOT the toggle class: that class read said SIM on two windows whose
      // screenshots both showed REAL highlighted (2026-09-26). The screenshot is the operator's check.
      let mode: BrowserStatus['mode'] = 'unknown'
      if (info.loggedIn && balance != null) mode = balance > 100_000 ? 'SIM' : 'REAL'
      return { up: true, loggedIn: info.loggedIn, balance, mode }
    } finally { await browser.close() }
  } catch { return { up: true } }
}

/** Is a placer already driving the Chrome on this port? (its lock file names a live process) */
export function placerRunningOn(port: number): boolean {
  try {
    const pid = Number(readFileSync(`.placer-cdp-${port}.lock`, 'utf8'))
    if (!pid) return false
    process.kill(pid, 0)   // throws if the process is gone
    return true
  } catch { return false }
}

/**
 * How many placement windows to run on this PC. One account can only SUBMIT one slip at a time (~3s of a
 * ~12s slip), so beyond ~4 windows extra ones just queue for the submit — hence the default cap of 4
 * (PLACEMENT_MAX_BROWSERS overrides). Small sessions don't need the extra windows' start-up cost.
 */
export function autoBrowsers(pending: number, requested?: number | 'auto'): number {
  const cap = Math.min(8, Math.max(1, Number(process.env.PLACEMENT_MAX_BROWSERS) || 4))
  if (typeof requested === 'number') return Math.min(cap, Math.max(1, Math.floor(requested)))
  return Math.min(cap, Math.max(1, Math.ceil(pending / 50)))
}

/** Where the REAL/SIM toggle screenshot for a placement window is saved. */
export const toggleShotPath = (port: number) => `logs/mode-${port}.png`

/** Screenshot the betslip's REAL/SIM toggle (logs/mode-<port>.png). Read-only; returns false if not found. */
export async function shotToggle(page: import('playwright').Page, port: number): Promise<boolean> {
  try {
    mkdirSync('logs', { recursive: true })
    const box = page.locator('[data-op=switch-box-left]').first().locator('xpath=ancestor::*[.//*[@data-op="switch-box-right"]][1]')
    if (!(await box.count())) return false
    await box.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
    await box.screenshot({ path: toggleShotPath(port), timeout: 5000 })
    return true
  } catch { return false }
}

/** Take a fresh toggle screenshot of an already-open window (no navigation). */
export async function refreshToggleShot(port = MAIN_PORT): Promise<boolean> {
  if (!(await cdpUp(port))) return false
  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.connectOverCDP(cdpBase(port))
    try {
      const page = browser.contexts()[0]?.pages().find(p => /sportybet\.com/.test(p.url()))
      return page ? await shotToggle(page, port) : false
    } finally { await browser.close() }
  } catch { return false }
}

/** SportyBet's narrow layout drops the header balance → widen a normal window narrower than 1280px. */
async function widenWindow(ctx: import('playwright').BrowserContext, page: import('playwright').Page): Promise<boolean> {
  try {
    const s = await ctx.newCDPSession(page)
    try {
      const { windowId, bounds } = await s.send('Browser.getWindowForTarget') as { windowId: number; bounds: { width?: number; height?: number; windowState?: string } }
      if (bounds.windowState !== 'normal' || (bounds.width ?? 0) >= 1280) return false
      await s.send('Browser.setWindowBounds', { windowId, bounds: { width: 1300, height: Math.max(bounds.height ?? 0, 850) } })
      await sleep(800)
      return true
    } finally { await s.detach().catch(() => {}) }
  } catch { return false }
}

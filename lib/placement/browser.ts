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

/** Deeper status: connect over CDP, read the balance + REAL/SIM toggle. Cheap, read-only. */
export async function browserStatus(): Promise<BrowserStatus> {
  if (!(await cdpUp())) return { up: false }
  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.connectOverCDP(CDP)
    try {
      const ctx = browser.contexts()[0]
      const page = ctx?.pages().find(p => /sportybet\.com/.test(p.url())) ?? ctx?.pages()[0]
      if (!page) return { up: true, loggedIn: false }
      const text = await page.evaluate(() => document.body.innerText).catch(() => '')
      const m = text.match(/NGN\s*([\d,.]+)/)
      const balance = m ? parseFloat(m[1].replace(/,/g, '')) : null
      const real = await page.evaluate(() => {
        const l = document.querySelector('[data-op=switch-box-left]')
        const s = document.querySelector('[data-op=switch-box-right]')
        if (!l && !s) return 'unknown'
        return /show-highlight/.test(l?.className || '') ? 'REAL' : /show-highlight/.test(s?.className || '') ? 'SIM' : 'unknown'
      }).catch(() => 'unknown')
      return { up: true, loggedIn: balance != null, balance, mode: real as BrowserStatus['mode'] }
    } finally { await browser.close() }
  } catch { return { up: true } }
}

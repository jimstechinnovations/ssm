// lib/placement/cdp-fetch.ts
// A fetch that runs INSIDE the debug Chrome (CDP) instead of as a server-side Node request, with a raw
// Node fetch as the fallback. Found live 2026-10-01: SportyBet's edge started silently dropping our
// server's raw requests at the TCP/TLS handshake (never reaching HTTP) after heavy automated use — a real
// Chrome reached the exact same URLs fine from the same machine/IP, so it's the connection's own
// fingerprint being filtered, not an IP block; no header can fake that. It is intermittent (clears and
// re-trips), so this tries CDP FIRST whenever a browser is prepared, and only falls back to the raw fetch
// when no browser is up.
//
// It uses ONE dedicated tab parked on `${origin}/robots.txt`, never the placer's tab:
//  - robots.txt is same-origin but runs no scripts, so window.fetch is native there. (On the normal site,
//    SportyBet's Grafana Faro wraps window.fetch and throws its own "Sorry, something went wrong" error.)
//  - the placer's tab is never touched (it may be mid-Confirm), and the tab is reused across calls and
//    concurrent callers (a lock), so we never pile up tabs — leaked tabs took Chrome to 188 processes and
//    0.44 GB free RAM on 2026-10-01.

import 'server-only'
import { cdpUp, MAIN_PORT } from './browser'

export interface CdpFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

type Tab = { browser: import('playwright').Browser; page: import('playwright').Page }
const tabs = new Map<string, Tab>()                    // `${port}|${origin}` → the dedicated tab
const opening = new Map<string, Promise<Tab>>()        // in-flight opens, so concurrent callers share one

async function alive(t: Tab) {
  try { return !t.page.isClosed() && t.browser.isConnected() && (await Promise.race([t.page.evaluate(() => 1), new Promise(r => setTimeout(() => r(0), 4000))])) === 1 }
  catch { return false }
}

async function getTab(origin: string, port: number): Promise<Tab> {
  const key = `${port}|${origin}`
  const cached = tabs.get(key)
  if (cached && await alive(cached)) return cached
  if (cached) { tabs.delete(key); await cached.page.close().catch(() => {}) }
  const pending = opening.get(key)
  if (pending) return pending
  const p = (async () => {
    const { chromium } = await import('playwright')
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 8000 })
    const ctx = browser.contexts()[0]
    // re-adopt a parked tab left by an earlier server process instead of opening another
    let page = ctx.pages().find(pg => pg.url() === `${origin}/robots.txt`)
    if (!page) { page = await ctx.newPage(); await page.goto(`${origin}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 20_000 }) }
    const t = { browser, page }
    tabs.set(key, t)
    return t
  })().finally(() => opening.delete(key))
  opening.set(key, p)
  return p
}

/** Fetch `path` (relative to `origin`) through the real browser when one is prepared, else raw Node fetch.
 *  Returns parsed JSON; throws on a non-2xx response or unparseable body either way. */
export async function cdpFetch<T = unknown>(origin: string, path: string, init: CdpFetchInit = {}, port = MAIN_PORT): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 10_000
  if (await cdpUp(port)) {
    try {
      const { page } = await getTab(origin, port)
      // forbidden headers (User-Agent…) are dropped by the browser anyway — it sends its own real ones
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'user-agent'))
      return await page.evaluate(async ({ path, method, headers, body, timeoutMs }) => {
        const r = await fetch(path, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      }, { path, method: init.method ?? 'GET', headers, body: init.body, timeoutMs })
    } catch (e) {
      // an HTTP error from the site is a real answer — don't retry it raw; a broken tab/connection is not
      if (e instanceof Error && /HTTP \d{3}/.test(e.message)) throw e
      tabs.delete(`${port}|${origin}`)
    }
  }
  const r = await fetch(origin + path, { method: init.method ?? 'GET', headers: init.headers, body: init.body, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

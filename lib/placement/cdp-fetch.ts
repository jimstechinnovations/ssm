// lib/placement/cdp-fetch.ts
// A fetch that runs INSIDE the debug Chrome (CDP) instead of as a server-side Node request, with a raw
// Node fetch as the fallback. Found live 2026-10-01: SportyBet's edge started silently dropping our
// server's raw requests at the TCP/TLS handshake (never reaching HTTP) after heavy automated use — a real
// Chrome reached the exact same URLs fine from the same machine/IP, so it's the connection's own
// fingerprint being filtered, not an IP block; no header can fake that. Confirmed intermittent (it clears
// and re-trips through the day), so this tries CDP FIRST whenever a browser is prepared (reliable), and
// only falls back to the raw fetch when no browser is up — never the other way around.
//
// window.fetch on sportybet.com is itself monkey-patched by their Grafana Faro instrumentation, which
// throws its own generic error instead of making the request — so the in-page fetch runs from a throwaway
// iframe, which gets a clean, unpatched fetch (iframe.contentWindow.fetch).

import 'server-only'
import { cdpUp, MAIN_PORT } from './browser'

export interface CdpFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

/** Keep ONE CDP connection + page for this process (reconnecting per call would fight the placer's own
 *  connection and is slow); dropped and re-opened if it ever goes stale. */
let cached: { browser: import('playwright').Browser; page: import('playwright').Page } | null = null

async function getPage(origin: string, port: number) {
  if (cached) {
    try { if (!cached.page.isClosed() && (await cached.page.evaluate(() => 1).catch(() => null)) === 1) return cached.page } catch { /* stale */ }
    cached = null
  }
  const { chromium } = await import('playwright')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 8000 })
  const ctx = browser.contexts()[0]
  let page = ctx.pages().find(p => p.url().startsWith(origin))
  if (!page) { page = await ctx.newPage(); await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {}) }
  cached = { browser, page }
  return page
}

/** Fetch `path` (relative to `origin`) through the real browser tab when one is prepared, else raw Node
 *  fetch. Returns parsed JSON. Throws on a non-2xx raw response or a JSON parse failure either way. */
export async function cdpFetch<T = unknown>(origin: string, path: string, init: CdpFetchInit = {}, port = MAIN_PORT): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 10_000
  if (await cdpUp(port)) {
    try {
      const page = await getPage(origin, port)
      return await page.evaluate(async ({ path, init, timeoutMs }) => {
        const iframe = document.createElement('iframe')
        iframe.style.display = 'none'
        document.body.appendChild(iframe)
        try {
          const nativeFetch = (iframe.contentWindow as Window).fetch.bind(window)
          const r = await nativeFetch(path, { method: init.method ?? 'GET', headers: init.headers, body: init.body, signal: AbortSignal.timeout(timeoutMs) })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        } finally { iframe.remove() }
      }, { path, init, timeoutMs })
    } catch { cached = null /* fall through to raw fetch below */ }
  }
  const r = await fetch(origin + path, { method: init.method ?? 'GET', headers: init.headers, body: init.body, signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

// lib/pedlas/results.ts
// Final scores for SportyBet fixtures, by the SAME id our slips use (sr:match:N). Plain server fetch
// (the factsCenter event endpoint isn't Cloudflare-gated) — no browser needed. total = home + away.

import 'server-only'
import type { GameResult } from './settle-slips'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'
const FINISHED = /end|finish|\bft\b|full.?time|awarded|closed/i

/** Parse "H#A" / "H:A" / "H-A" → total goals, or null. (productStatus was "0#0" pre-match.) */
function parseTotal(...vals: (string | undefined)[]): number | null {
  for (const v of vals) { const m = (v ?? '').match(/(\d+)\s*[#:\-]\s*(\d+)/); if (m) return Number(m[1]) + Number(m[2]) }
  return null
}

export async function fetchResult(fixtureId: number): Promise<GameResult | null> {
  try {
    const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${fixtureId}&productId=1`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!r.ok) return null
    const d = (await r.json())?.data as Record<string, string> | undefined
    if (!d) return null
    const finished = FINISHED.test(d.matchStatus || d.status || '')
    const total = parseTotal(d.setScore, d.productStatus, d.gameScore)
    if (total == null) return { finished, total: 0 }
    return { finished, total }
  } catch { return null }
}

/** Fetch results for many fixtures (bounded concurrency). */
export async function fetchResults(fixtureIds: number[]): Promise<Map<number, GameResult | null>> {
  const out = new Map<number, GameResult | null>()
  const ids = [...new Set(fixtureIds)]
  const CONC = 6
  for (let i = 0; i < ids.length; i += CONC) {
    const chunk = ids.slice(i, i + CONC)
    const got = await Promise.all(chunk.map(id => fetchResult(id)))
    chunk.forEach((id, k) => out.set(id, got[k]))
  }
  return out
}

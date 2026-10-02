// lib/books/sportybet-bets.ts
// The account's OPEN bets as SportyBet itself sees them (GET /api/ng/orders/order/v2/realbetlist?isSettled=0,
// the list behind "Bet History → Unsettled"). Read-only. It needs the logged-in browser, so it goes
// through cdpFetch's parked tab (same origin → the account's cookies); without a prepared browser it throws.
//
// Why: our own settlement waits for full time, while SportyBet settles a leg the moment it can't win, and
// sometimes lags behind a finished game. On 2 Oct the operator saw 24 → 21 → 18 → 16 and couldn't tell
// which number was right. Matching each open bet to our slip by its exact selections settles that.

import 'server-only'
import { cdpFetch } from '../placement/cdp-fetch'

export interface SiteSelection { fixtureId: number; marketId: string; specifier: string; outcomeId: string; status: number; matchStatus?: string; score?: string; played?: string }
export interface SiteBet { orderId: string; shortId: string; stake: number; createdAt: number; selections: SiteSelection[] }

interface RawSel { eventId?: string; marketId?: string; specifier?: string; outcomeId?: string; status?: number; matchStatus?: string; setScore?: string; playedSeconds?: string }
interface RawOrder { orderId?: string; shortId?: string; totalStake?: string; createTime?: number; selections?: RawSel[] }

/** Every open (unsettled) bet on the logged-in account. */
export async function fetchOpenBets(maxPages = 20): Promise<SiteBet[]> {
  const out: SiteBet[] = []
  for (let page = 1; page <= maxPages; page++) {
    const j = await cdpFetch<{ bizCode?: number; message?: string; data?: { totalNum?: number; entityList?: RawOrder[] } }>(
      'https://www.sportybet.com', `/api/ng/orders/order/v2/realbetlist?isSettled=0&pageSize=50&pageNo=${page}&_t=${Date.now()}`, { timeoutMs: 15_000 })
    if (j.bizCode !== 10000) throw new Error(`SportyBet open bets unavailable (bizCode ${j.bizCode}${j.message ? `: ${j.message}` : ''}) — is the browser prepared and logged in?`)
    const list = j.data?.entityList ?? []
    for (const o of list) out.push({
      orderId: o.orderId ?? '', shortId: o.shortId ?? '', stake: Number(o.totalStake ?? 0), createdAt: o.createTime ?? 0,
      selections: (o.selections ?? []).map(s => ({
        fixtureId: Number(String(s.eventId ?? '').split(':').pop()), marketId: String(s.marketId ?? ''), specifier: s.specifier ?? '',
        outcomeId: String(s.outcomeId ?? ''), status: s.status ?? 0, matchStatus: s.matchStatus, score: s.setScore, played: s.playedSeconds,
      })),
    })
    if (list.length < 50 || out.length >= (j.data?.totalNum ?? 0)) break
  }
  return out
}

/** The signature a bet and our slip share: its exact selections, order-free. */
export const selectionSig = (sels: { fixtureId: number; marketId: string; specifier: string; outcomeId: string }[]) =>
  sels.map(s => `${s.fixtureId}|${s.marketId}|${s.specifier}|${s.outcomeId}`).sort().join(',')

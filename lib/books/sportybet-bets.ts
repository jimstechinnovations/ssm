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

/** A settled bet: what it paid, and whether it was CASHED OUT. SportyBet has no cash-out flag on the order;
 *  a cash-out is a PAID bet (winningStatus 20) settled while some of its legs were still unsettled (status 0)
 *  — a real win can only pay once every leg has settled. Proven on 2026-10-04: #22 of S-B44EC5 (HA074L)
 *  paid ₦487.81 with 4 games not yet started; a lost bet is winningStatus 30. */
export interface SettledBet { orderId: string; shortId: string; code: string; stake: number; createdAt: number; paid: number; won: boolean; lost: boolean; cashedOut: boolean; looseSig: string }

/** Game + market + pick, order-free, WITHOUT the line: the settled list omits `specifier`, and a placed Flexi
 *  ticket gets its own code (not the booking code), so this is how a settled ticket is matched to our slip. */
export const looseSig = (sels: { fixtureId: number; marketId: string; outcomeId: string }[]) =>
  sels.map(s => `${s.fixtureId}|${s.marketId}|${s.outcomeId}`).sort().join(',')

/** Settled bets, newest first, until `until(bets)` is satisfied or `maxPages` run out. */
export async function fetchSettledBets(opts: { maxPages?: number; since?: number; until?: (bets: SettledBet[]) => boolean } = {}): Promise<SettledBet[]> {
  const out: SettledBet[] = []
  for (let page = 1; page <= (opts.maxPages ?? 10); page++) {
    const j = await cdpFetch<{ bizCode?: number; message?: string; data?: { totalNum?: number; entityList?: (RawOrder & { shareCode?: string; totalWinnings?: string; winningStatus?: number })[] } }>(
      'https://www.sportybet.com', `/api/ng/orders/order/v2/realbetlist?isSettled=1&pageSize=50&pageNo=${page}&_t=${Date.now()}`, { timeoutMs: 15_000 })
    if (j.bizCode !== 10000) throw new Error(`SportyBet settled bets unavailable (bizCode ${j.bizCode}${j.message ? `: ${j.message}` : ''})`)
    const list = j.data?.entityList ?? []
    for (const o of list) {
      const paid = Number(o.totalWinnings ?? 0), won = o.winningStatus === 20 && paid > 0
      out.push({ orderId: o.orderId ?? '', shortId: o.shortId ?? '', code: o.shareCode ?? '', stake: Number(o.totalStake ?? 0), createdAt: o.createTime ?? 0,
        paid, won, lost: o.winningStatus === 30, cashedOut: won && (o.selections ?? []).some(s => (s.status ?? 0) === 0),
        looseSig: looseSig((o.selections ?? []).map(s => ({ fixtureId: Number(String(s.eventId ?? '').split(':').pop()), marketId: String(s.marketId ?? ''), outcomeId: String(s.outcomeId ?? '') }))) })
    }
    const oldest = list.at(-1)?.createTime ?? 0
    if (list.length < 50 || (opts.since && oldest < opts.since) || opts.until?.(out)) break
  }
  return out
}

/** The signature a bet and our slip share: its exact selections, order-free. */
export const selectionSig = (sels: { fixtureId: number; marketId: string; specifier: string; outcomeId: string }[]) =>
  sels.map(s => `${s.fixtureId}|${s.marketId}|${s.specifier}|${s.outcomeId}`).sort().join(',')

// lib/books/boosts.ts
// Client-safe Win Boost lookup per bookmaker. Kept separate from the adapters (which pull in
// server-only I/O) so UI code can recompute payouts when editing a saved book.
//
// HONESTY RULE: a book whose bonus table has not been verified against a real betslip uses
// ZERO boost — payouts must never be overstated (pedla_v1.md §3).

import { boostFor as betwayNigeriaBoostFor, noBoost, type BoostFn } from '../pedlas/boost'

export const BOOK_BOOSTS: Record<string, BoostFn> = {
  betway_nigeria: betwayNigeriaBoostFor, // measured against the live Betway Nigeria betslip
  sportybet:      noBoost,               // TODO verify SportyBet NG multiple-bonus table live
  stake:          noBoost,               // TODO verify Stake multi bonus (if any) live
}

/** Boost table for a book id; unknown/legacy books fall back to Betway Nigeria (pre-multi-book saves). */
export function boostForBook(bookId?: string): BoostFn {
  if (!bookId) return betwayNigeriaBoostFor
  return BOOK_BOOSTS[bookId] ?? noBoost
}

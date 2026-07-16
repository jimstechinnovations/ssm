// lib/placement/receipt.ts
// What a placement must PROVE before we call it placed.
//
// Hard lesson (2026-07-13): the first live run reported "placed" because the page text matched
// a loose /success|ticket/ regex — but SportyBet's own history said "No Bets Available" and the
// balance never moved. Page text is NOT evidence. A placement counts only when the SITE agrees:
//   • the account balance dropped by (about) the stake, AND/OR
//   • the bet is visible in the book's own bet history with an id.
// Anything less is `confirmed: false` and the job fails — never a silent success.

export interface PlacementReceipt {
  confirmed: boolean
  confirmedBy: 'balance+history' | 'balance' | 'history' | 'none'
  bookingCode?: string      // the shareable slip code (SportyBet) — lets a human open the same slip
  betId?: string            // the book's own bet/ticket id, when it exposes one
  balanceBefore?: number
  balanceAfter?: number
  siteOdds?: number         // total odds as the SITE displayed them (drift evidence)
  sitePotentialWin?: number
  detail?: string           // why it failed, when it did
}

/** Parse "NGN 1,234.56" / "₦1,234.56" → 1234.56. */
export function parseMoney(text: string | null | undefined): number | undefined {
  if (!text) return undefined
  const m = text.match(/(?:NGN|₦)\s*([\d,]+(?:\.\d+)?)/i)
  if (!m) return undefined
  const n = parseFloat(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/**
 * Did the balance move by the stake? Tolerant of a small delta (bonus/rounding), but it MUST
 * have gone down by roughly the stake — an unchanged balance is proof the bet did not land.
 */
export function balanceConfirms(before: number | undefined, after: number | undefined, stake: number): boolean {
  if (before == null || after == null) return false
  const drop = before - after
  return drop >= stake * 0.95 && drop <= stake * 1.05
}

// lib/ssm/session.ts
// Pure helper functions for generating session prefixes and slip hash identifiers.

import { randomBytes } from 'crypto'

/**
 * Generates a unique session prefix for the given date.
 *
 * Format: `SESS-{YYYYMMDD}-{4 hex chars}`
 *
 * The date components are derived from the UTC calendar date of the supplied
 * `Date` object so the prefix is stable regardless of the server's local
 * timezone. The 4 hex characters come from Node's `crypto.randomBytes(2)`,
 * providing cryptographic entropy.
 *
 * Example output: `SESS-20260614-a3f2`
 *
 * Requirements: 4.9, 11.1
 */
export function generateSessionPrefix(date: Date): string {
  const year  = date.getUTCFullYear().toString()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day   = String(date.getUTCDate()).padStart(2, '0')
  const dateStr = `${year}${month}${day}`

  const entropy = randomBytes(2).toString('hex') // 4 lowercase hex chars

  return `SESS-${dateStr}-${entropy}`
}

/**
 * Derives the full slip hash identifier from a session prefix, account number,
 * and the slip's position within that account.
 *
 * Format: `{prefix}-A{accountNum:02d}-S{slipNum:02d}`
 *
 * Both `accountNum` and `slipNum` are zero-padded to 2 digits.
 *
 * Example: `generateSlipHash('SESS-20260614-a3f2', 3, 5)` → `'SESS-20260614-a3f2-A03-S05'`
 *
 * Requirements: 11.2
 */
export function generateSlipHash(
  prefix: string,
  accountNum: number,
  slipNum: number,
): string {
  const a = String(accountNum).padStart(2, '0')
  const s = String(slipNum).padStart(2, '0')
  return `${prefix}-A${a}-S${s}`
}

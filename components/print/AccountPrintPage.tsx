/**
 * components/print/AccountPrintPage.tsx
 *
 * Renders ONE account's full slip set for physical printing.
 * No 'use client' — purely presentational, renders as a React Server Component.
 *
 * Each account block uses `print:break-after-page` so every account lands on
 * its own printed page (Requirement 9.1).
 *
 * Layout per slip:
 *   - Checkbox for physical operator to mark as placed (Requirement 9.3)
 *   - Session hash identifier in monospace (Requirements 9.2, 11.3)
 *   - 8 leg rows: match index, home v away, market, outcome, state, odds
 *   - Footer: combined odds, stake, payout (Requirement 9.2)
 *
 * Styling: black text on white background, border-black, high-contrast for
 * physical printing (Requirement 9.2).
 *
 * Requirements: 9.1, 9.2, 9.3, 9.5
 */

import React from 'react'
import type { AccountAllocation, Slip, SlipLeg } from '@/lib/ssm/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccountPrintPageProps {
  allocation: AccountAllocation
  sessionPrefix: string
  groupId?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const marketLabels: Record<string, string> = {
  '1X2': '1X2',
  BTTS: 'BTTS',
  'OVER_UNDER_1.5': 'O/U 1.5',
  'OVER_UNDER_2.5': 'O/U 2.5',
  'OVER_UNDER_3.5': 'O/U 3.5',
  ASIAN_HANDICAP: 'AH',
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PrintLegRow({ leg }: { leg: SlipLeg }) {
  return (
    <tr className="border-b border-black">
      <td className="px-2 py-1 text-center font-mono text-xs">{leg.matchIndex}</td>
      <td className="px-2 py-1 text-xs">
        {leg.homeTeam} v {leg.awayTeam}
      </td>
      <td className="px-2 py-1 text-center text-xs font-medium uppercase">
        {marketLabels[leg.market] ?? leg.market}
      </td>
      <td className="px-2 py-1 text-xs">{leg.outcome}</td>
      <td className="px-2 py-1 text-center font-mono text-xs">
        S{leg.state}
      </td>
      <td className="px-2 py-1 text-right font-mono text-xs">
        {leg.odds.toFixed(2)}
      </td>
    </tr>
  )
}

function PrintSlip({ slip }: { slip: Slip }) {
  const hasPayout = slip.stake > 0 && slip.potentialPayout > 0

  return (
    <div className="mb-4 border border-black">
      {/* Slip header: checkbox + session hash */}
      <div className="flex items-center gap-3 border-b border-black bg-zinc-100 px-3 py-2 print:bg-gray-100">
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer border border-black"
          aria-label={`Mark slip ${slip.sessionHash} as placed`}
        />
        <span className="font-mono text-xs font-semibold tracking-wide">
          {slip.sessionHash}
        </span>
        <span className="ml-auto text-xs font-medium uppercase text-zinc-600 print:text-gray-600">
          {slip.tier} #{slip.slipId}
        </span>
      </div>

      {/* Legs table */}
      <table className="w-full border-collapse text-black">
        <thead>
          <tr className="border-b border-black bg-zinc-50 print:bg-gray-50">
            <th className="px-2 py-1 text-center text-[10px] font-semibold uppercase tracking-wide">
              #
            </th>
            <th className="px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide">
              Match
            </th>
            <th className="px-2 py-1 text-center text-[10px] font-semibold uppercase tracking-wide">
              Mkt
            </th>
            <th className="px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide">
              Outcome
            </th>
            <th className="px-2 py-1 text-center text-[10px] font-semibold uppercase tracking-wide">
              St
            </th>
            <th className="px-2 py-1 text-right text-[10px] font-semibold uppercase tracking-wide">
              Odds
            </th>
          </tr>
        </thead>
        <tbody>
          {slip.legs.map((leg) => (
            <PrintLegRow key={leg.matchIndex} leg={leg} />
          ))}
        </tbody>
      </table>

      {/* Slip footer: combined odds, stake, payout */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-black px-3 py-2 text-xs font-medium">
        <span>
          Combined:{' '}
          <span className="font-mono font-bold">{slip.combinedOdds.toFixed(2)}</span>
        </span>
        <span>
          Stake:{' '}
          <span className="font-bold">₦{slip.stake.toLocaleString()}</span>
        </span>
        <span>
          Payout:{' '}
          <span className="font-bold">
            {hasPayout ? `₦${slip.potentialPayout.toLocaleString()}` : '—'}
          </span>
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AccountPrintPage({ allocation, sessionPrefix, groupId }: AccountPrintPageProps) {
  return (
    /*
     * print:break-after-page ensures each account starts on a new printed
     * page when multiple AccountPrintPage instances are rendered together.
     * Requirements: 9.1
     */
    <div className="min-h-screen bg-white p-6 text-black print:break-after-page print:bg-white print:p-4 print:text-black">
      {/* Account header */}
      <div className="mb-4 border-b-2 border-black pb-3">
        <h1 className="text-xl font-bold tracking-wide">
          ACCOUNT {allocation.accountNumber} — {allocation.profile}
        </h1>
        <p className="mt-1 font-mono text-sm text-zinc-600 print:text-gray-600">
          Session: {sessionPrefix}
        </p>
        {groupId && (
          <p className="mt-0.5 font-mono text-sm text-zinc-600 print:text-gray-600">
            Group: {groupId.slice(0, 8)}…
          </p>
        )}
        <p className="mt-0.5 text-xs text-zinc-500 print:text-gray-500">
          {allocation.slips.length} slip{allocation.slips.length !== 1 ? 's' : ''} ·
          Total stake: ₦{allocation.totalStake.toLocaleString()}
        </p>
      </div>

      {/* Slips */}
      <div>
        {allocation.slips.map((slip) => (
          <PrintSlip key={slip.slipId} slip={slip} />
        ))}
      </div>
    </div>
  )
}

export default AccountPrintPage

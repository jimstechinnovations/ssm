/**
 * components/matrix/SlipCard.tsx
 *
 * Displays a single betting slip with its 8 legs, tier badge, session hash,
 * combined odds, stake, and potential payout.
 *
 * Requirements: 8.2, 11.3
 */

'use client'

import React from 'react'
import { Card } from '@/components/ui/Card'
import { TierBadge } from '@/components/matrix/TierBadge'
import { OddsDisplay } from '@/components/matrix/OddsDisplay'
import type { Slip, SlipLeg } from '@/lib/ssm/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlipCardProps {
  slip: Slip
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

function StateBadge({ state }: { state: 0 | 1 }) {
  if (state === 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-900 dark:text-blue-200">
        S0
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900 dark:text-amber-200">
      S1
    </span>
  )
}

function LegRow({ leg }: { leg: SlipLeg }) {
  return (
    <div className="grid grid-cols-[1.5rem_1fr_auto_auto_auto] items-center gap-x-2 gap-y-0.5 py-1 text-xs sm:grid-cols-[1.5rem_1fr_5rem_4rem_auto_auto]">
      {/* Match index */}
      <span className="text-center font-mono text-zinc-400 dark:text-zinc-500">
        {leg.matchIndex}
      </span>

      {/* Teams */}
      <span className="truncate font-medium text-zinc-700 dark:text-zinc-200">
        <span className="hidden sm:inline">{leg.homeTeam} v {leg.awayTeam}</span>
        <span className="sm:hidden">
          {leg.homeTeam.length + leg.awayTeam.length > 22
            ? `${leg.homeTeam.slice(0, 10)}… v ${leg.awayTeam.slice(0, 10)}…`
            : `${leg.homeTeam} v ${leg.awayTeam}`}
        </span>
      </span>

      {/* Market */}
      <span className="hidden rounded bg-zinc-100 px-1.5 py-0.5 text-center text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400 sm:inline">
        {marketLabels[leg.market] ?? leg.market}
      </span>

      {/* Outcome */}
      <span className="hidden truncate text-zinc-600 dark:text-zinc-300 sm:inline">
        {leg.outcome}
      </span>

      {/* State badge */}
      <StateBadge state={leg.state} />

      {/* Odds */}
      <OddsDisplay odds={leg.odds} className="text-right text-xs" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SlipCard({ slip }: SlipCardProps) {
  const hasPayout = slip.stake > 0 && slip.potentialPayout > 0

  return (
    <Card className="p-3 sm:p-4">
      {/* ── Header ── */}
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-bold text-zinc-800 dark:text-zinc-100">
          Slip #{slip.slipId}
        </span>
        <TierBadge tier={slip.tier} />
        <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
          {slip.sessionHash}
        </span>
      </div>

      {/* ── Divider ── */}
      <div className="mb-1 h-px bg-zinc-100 dark:bg-zinc-800" />

      {/* ── Leg rows ── */}
      <div className="divide-y divide-zinc-50 dark:divide-zinc-800/60">
        {slip.legs.map((leg) => (
          <LegRow key={leg.matchIndex} leg={leg} />
        ))}
      </div>

      {/* ── Divider ── */}
      <div className="mt-1 h-px bg-zinc-100 dark:bg-zinc-800" />

      {/* ── Footer ── */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        <span className="flex items-center gap-1">
          <span className="font-medium text-zinc-500 dark:text-zinc-400">Odds</span>
          <OddsDisplay odds={slip.combinedOdds} className="font-semibold text-zinc-800 dark:text-zinc-100" />
        </span>

        <span className="flex items-center gap-1">
          <span className="font-medium text-zinc-500 dark:text-zinc-400">Stake</span>
          <span className="font-semibold text-zinc-800 dark:text-zinc-100">
            ₦{slip.stake.toLocaleString()}
          </span>
        </span>

        <span className="flex items-center gap-1">
          <span className="font-medium text-zinc-500 dark:text-zinc-400">Payout</span>
          <span className="font-semibold text-zinc-800 dark:text-zinc-100">
            {hasPayout ? `₦${slip.potentialPayout.toLocaleString()}` : '—'}
          </span>
        </span>
      </div>
    </Card>
  )
}

export default SlipCard

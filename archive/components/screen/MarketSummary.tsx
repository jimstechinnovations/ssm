/**
 * components/screen/MarketSummary.tsx
 *
 * Displays the dominant and breakout market for a screened fixture set.
 * Returns null when dominantMarket prop is null.
 * Requirements: 4.5
 */

import React from 'react'
import type { DominantMarketResult, MarketOutcome } from '@/lib/ssm/types'
import { OUTCOME_TO_LABEL } from '@/lib/ssm/types'

export interface MarketSummaryProps {
  dominantMarket: DominantMarketResult | null
}

/** Human-readable label for a MarketOutcome value. */
function outcomeLabel(outcome: MarketOutcome): string {
  return OUTCOME_TO_LABEL[outcome] ?? outcome
}

export function MarketSummary({ dominantMarket }: MarketSummaryProps) {
  if (dominantMarket === null) return null

  const {
    dominantOutcome,
    avgImpliedProb,
    breakoutOutcome,
    tieBroken,
    tieBreakDetail,
  } = dominantMarket

  const pct = (avgImpliedProb * 100).toFixed(1)

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-800 dark:bg-blue-950/30">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
        Market Analysis
      </h3>

      <dl className="flex flex-col gap-1.5">
        {/* Dominant market */}
        <div className="flex items-baseline gap-2">
          <dt className="w-36 shrink-0 text-sm text-zinc-500 dark:text-zinc-400">
            Dominant Market
          </dt>
          <dd className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {outcomeLabel(dominantOutcome)}{' '}
            <span className="font-normal text-zinc-500 dark:text-zinc-400">
              (avg {pct}%)
            </span>
          </dd>
        </div>

        {/* Breakout market */}
        <div className="flex items-baseline gap-2">
          <dt className="w-36 shrink-0 text-sm text-zinc-500 dark:text-zinc-400">
            Breakout Market
          </dt>
          <dd className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {outcomeLabel(breakoutOutcome)}
          </dd>
        </div>
      </dl>

      {/* Tie-break note */}
      {tieBroken && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          <span className="font-semibold">⚠ Tie broken</span>
          {' — '}
          {tieBreakDetail ?? 'Tie broken by lowest variance'}
        </p>
      )}
    </div>
  )
}

export default MarketSummary

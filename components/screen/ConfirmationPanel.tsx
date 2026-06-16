'use client'

/**
 * components/screen/ConfirmationPanel.tsx
 *
 * Composes QualifyingFixtureList, MarketSummary, BankrollInput, and a live
 * tier-allocation preview before the user confirms generation.
 *
 * Requirements: 3.6, 3.7, 4.5, 5.3, 5.4, 13.4
 */

import React, { useState, useMemo } from 'react'
import type { FixtureWithGates, DominantMarketResult, TierAllocation } from '@/lib/ssm/types'
import { calculateStakes } from '@/lib/ssm/stake-calculator'
import { QualifyingFixtureList } from '@/components/screen/QualifyingFixtureList'
import { MarketSummary } from '@/components/screen/MarketSummary'
import { BankrollInput } from '@/components/screen/BankrollInput'
import { Button } from '@/components/ui/Button'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConfirmationPanelProps {
  qualifying: FixtureWithGates[]           // the top-8 selected fixtures
  dominantMarket: DominantMarketResult | null
  onConfirm: (bankroll: number, numAccounts: 6 | 7) => void
  loading?: boolean    // true while POST /api/generate is in-flight
  disabled?: boolean   // true when qualifying.length < 8
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a number as ₦X,XXX (no decimals). */
function fmt(n: number): string {
  return '₦' + n.toLocaleString('en-NG', { maximumFractionDigits: 0 })
}

// ─── Tier Allocation Preview ─────────────────────────────────────────────────

interface TierRowProps {
  label: string
  stakePerSlip: number
  slipCount: number
}

function TierRow({ label, stakePerSlip, slipCount }: TierRowProps) {
  const total = stakePerSlip * slipCount
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="w-14 font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
        {fmt(stakePerSlip)} × {slipCount} slips
      </span>
      <span className="tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
        = {fmt(total)}
      </span>
    </div>
  )
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ConfirmationPanel({
  qualifying,
  dominantMarket,
  onConfirm,
  loading = false,
  disabled = false,
}: ConfirmationPanelProps) {
  const [bankroll, setBankroll] = useState<number>(10_000)
  const [bankrollValid, setBankrollValid] = useState<boolean>(true)
  const [numAccounts, setNumAccounts] = useState<6 | 7>(7)

  // Live tier allocation — re-computes whenever bankroll changes
  const allocation = useMemo<TierAllocation | null>(() => {
    try {
      return calculateStakes(bankroll)
    } catch {
      return null
    }
  }, [bankroll])

  // Disable conditions
  const needsFixtures = qualifying.length < 8
  const needsBankroll = !bankrollValid || bankroll <= 0

  const isDisabled = needsFixtures || needsBankroll || loading || disabled

  // Human-readable reason for the badge
  const disabledReason: string | null = needsFixtures
    ? `Need ${8 - qualifying.length} more fixture${8 - qualifying.length === 1 ? '' : 's'}`
    : needsBankroll
      ? 'Invalid bankroll'
      : null

  function handleConfirm() {
    if (isDisabled) return
    onConfirm(bankroll, numAccounts)
  }

  return (
    <div className="flex flex-col gap-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
      {/* Section title */}
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
        Confirm &amp; Generate
      </h2>

      {/* Qualifying fixtures */}
      <QualifyingFixtureList fixtures={qualifying} />

      {/* Market summary */}
      {dominantMarket && <MarketSummary dominantMarket={dominantMarket} />}

      {/* Bankroll input */}
      <BankrollInput
        value={bankroll}
        onChange={setBankroll}
        onValidChange={setBankrollValid}
        disabled={loading}
      />

      {/* Tier allocation preview */}
      {allocation ? (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-800/50">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Tier Allocation Preview
          </h3>
          <div className="divide-y divide-zinc-200 dark:divide-zinc-700">
            <TierRow label="Core"  stakePerSlip={allocation.coreStakePerSlip}  slipCount={30} />
            <TierRow label="Pivot" stakePerSlip={allocation.pivotStakePerSlip} slipCount={8}  />
            <TierRow label="Chaos" stakePerSlip={allocation.chaosStakePerSlip} slipCount={4}  />
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-zinc-200 pt-2 text-sm dark:border-zinc-700">
            <span className="text-zinc-500 dark:text-zinc-400">Buffer</span>
            <span className="tabular-nums font-semibold text-zinc-700 dark:text-zinc-300">
              {fmt(allocation.buffer)}
            </span>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 text-center text-sm text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-500">
          Enter a valid bankroll to see tier allocation.
        </div>
      )}

      {/* numAccounts selector */}
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Number of Accounts
        </legend>
        <div className="flex gap-4">
          {([6, 7] as const).map((n) => (
            <label
              key={n}
              className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300"
            >
              <input
                type="radio"
                name="numAccounts"
                value={n}
                checked={numAccounts === n}
                onChange={() => setNumAccounts(n)}
                disabled={loading}
                className="accent-blue-600"
              />
              {n} accounts
            </label>
          ))}
        </div>
      </fieldset>

      {/* Confirm & Generate button + disabled reason badge */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="lg"
            disabled={isDisabled}
            loading={loading}
            onClick={handleConfirm}
            className="flex-1"
          >
            Confirm &amp; Generate
          </Button>

          {/* Inline reason badge — only shown when button is disabled */}
          {disabledReason && !loading && (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              {disabledReason}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default ConfirmationPanel

/**
 * components/accounts/AccountCard.tsx
 *
 * Displays one account's allocation: account number, profile badge, slip list
 * with inline tier badges, and total stake. When `allocation` is null, renders
 * a dashed-border placeholder card.
 *
 * Requirements: 8.3, 8.4
 */

'use client'

import React from 'react'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { TierBadge } from '@/components/matrix/TierBadge'
import type { AccountAllocation } from '@/lib/ssm/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccountCardProps {
  /** null = empty placeholder (account with no slips assigned yet) */
  allocation: AccountAllocation | null
  accountNumber: number
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AccountCard({ allocation, accountNumber }: AccountCardProps) {
  // ── Placeholder card ────────────────────────────────────────────────────
  if (allocation === null) {
    return (
      <div className="rounded-xl border-2 border-dashed border-zinc-300 p-6 dark:border-zinc-700">
        <h3 className="mb-1 text-sm font-bold text-zinc-500 dark:text-zinc-400">
          Account {accountNumber}
        </h3>
        <p className="text-xs text-zinc-400 dark:text-zinc-600">No slips assigned yet</p>
      </div>
    )
  }

  // ── Populated card ───────────────────────────────────────────────────────
  return (
    <Card>
      {/* ── Header ── */}
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-sm font-bold text-zinc-800 dark:text-zinc-100">
          Account {accountNumber}
        </h3>
        <Badge variant="default">{allocation.profile}</Badge>
      </div>

      {/* ── Divider ── */}
      <div className="mb-3 h-px bg-zinc-100 dark:bg-zinc-800" />

      {/* ── Slip list ── */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {allocation.slips.map((slip) => (
          <span
            key={slip.slipId}
            className="inline-flex items-center gap-1 rounded bg-zinc-50 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          >
            <span className="font-mono font-medium">#{slip.slipId}</span>
            <TierBadge tier={slip.tier} />
          </span>
        ))}
      </div>

      {/* ── Divider ── */}
      <div className="mb-2 h-px bg-zinc-100 dark:bg-zinc-800" />

      {/* ── Total stake ── */}
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        <span className="font-medium">Total Stake:</span>{' '}
        <span className="font-semibold text-zinc-800 dark:text-zinc-100">
          ₦{allocation.totalStake.toLocaleString()}
        </span>
      </p>
    </Card>
  )
}

export default AccountCard

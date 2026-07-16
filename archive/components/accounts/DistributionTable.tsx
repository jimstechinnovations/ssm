/**
 * components/accounts/DistributionTable.tsx
 *
 * Presentational summary table of all accounts' slip counts and total stakes.
 * Columns: Account | Profile | Core | Pivot | Chaos | Total | Stake
 *
 * If the distribution has fewer rows than numAccounts, placeholder rows are
 * rendered for the missing accounts.
 *
 * Requirements: 8.3, 8.4
 */

import React from 'react'
import type { AccountAllocation } from '@/lib/ssm/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DistributionTableProps {
  distribution: AccountAllocation[]
  numAccounts: 6 | 7
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countByTier(allocation: AccountAllocation, tier: 'CORE' | 'PIVOT' | 'CHAOS'): number {
  return allocation.slips.filter((s) => s.tier === tier).length
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DistributionTable({ distribution, numAccounts }: DistributionTableProps) {
  // Build a row entry for every expected account, filling gaps with null.
  const rows: (AccountAllocation | null)[] = Array.from({ length: numAccounts }, (_, i) => {
    return distribution.find((a) => a.accountNumber === i + 1) ?? null
  })

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {/* ── Head ── */}
        <thead>
          <tr className="border-b border-zinc-200 dark:border-zinc-700">
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Account
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Profile
            </th>
            <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
              Core
            </th>
            <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
              Pivot
            </th>
            <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
              Chaos
            </th>
            <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Total
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Stake
            </th>
          </tr>
        </thead>

        {/* ── Body ── */}
        <tbody>
          {rows.map((allocation, idx) => {
            const accountNumber = idx + 1
            const isEven = idx % 2 === 0

            // ── Placeholder row ──
            if (allocation === null) {
              return (
                <tr
                  key={accountNumber}
                  className={isEven ? 'bg-white dark:bg-zinc-900' : 'bg-zinc-50 dark:bg-zinc-800/40'}
                >
                  <td className="px-3 py-2 font-medium text-zinc-700 dark:text-zinc-300">
                    {accountNumber}
                  </td>
                  <td
                    colSpan={6}
                    className="px-3 py-2 text-xs italic text-zinc-400 dark:text-zinc-600"
                  >
                    No slips assigned yet
                  </td>
                </tr>
              )
            }

            // ── Data row ──
            const core = countByTier(allocation, 'CORE')
            const pivot = countByTier(allocation, 'PIVOT')
            const chaos = countByTier(allocation, 'CHAOS')
            const total = allocation.slips.length

            return (
              <tr
                key={accountNumber}
                className={isEven ? 'bg-white dark:bg-zinc-900' : 'bg-zinc-50 dark:bg-zinc-800/40'}
              >
                <td className="px-3 py-2 font-medium text-zinc-700 dark:text-zinc-300">
                  {accountNumber}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                  {allocation.profile}
                </td>
                <td className="px-3 py-2 text-center font-mono text-xs text-blue-700 dark:text-blue-300">
                  {core}
                </td>
                <td className="px-3 py-2 text-center font-mono text-xs text-amber-700 dark:text-amber-300">
                  {pivot}
                </td>
                <td className="px-3 py-2 text-center font-mono text-xs text-red-700 dark:text-red-300">
                  {chaos}
                </td>
                <td className="px-3 py-2 text-center font-mono text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                  {total}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-zinc-700 dark:text-zinc-300">
                  ₦{allocation.totalStake.toLocaleString()}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default DistributionTable

'use client'

/**
 * app/(builder)/accounts/page.tsx
 *
 * Step 3 of the SSM Builder: displays the account distribution summary
 * table and individual AccountCard for each account slot.
 *
 * Requirements: 8.3, 8.4
 */

import React from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

import { useSession } from '@/components/session/SessionProvider'
import { DistributionTable } from '@/components/accounts/DistributionTable'
import { AccountCard } from '@/components/accounts/AccountCard'
import { Skeleton } from '@/components/ui/Skeleton'

// ---------------------------------------------------------------------------
// Skeleton loading state
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Page heading skeleton */}
      <Skeleton className="mb-8 h-8 w-56" />

      {/* Table skeleton */}
      <div className="mb-8 flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>

      {/* Card grid skeleton */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            aria-hidden="true"
            className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-6 dark:border-zinc-700"
          >
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
            <Skeleton className="h-px w-full" />
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7].map((j) => (
                <Skeleton key={j} className="h-6 w-14 rounded" />
              ))}
            </div>
            <Skeleton className="h-px w-full" />
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AccountsPage() {
  const { state } = useSession()
  const { status, distribution, config } = state
  const searchParams = useSearchParams()
  const group = searchParams.get('group')

  // ── Loading state ────────────────────────────────────────────────────────

  if (status === 'loading') {
    return <LoadingSkeleton />
  }

  // ── No distribution yet ───────────────────────────────────────────────────

  if (status !== 'generated' || distribution === null) {
    return (
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-center px-4 py-24 sm:px-6 lg:px-8">
        <p className="mb-6 text-lg font-medium text-zinc-600 dark:text-zinc-400">
          No distribution yet
        </p>
        <Link
          href="/builder/dashboard"
          className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          ← Back to Dashboard
        </Link>
      </div>
    )
  }

  // ── Derived values ────────────────────────────────────────────────────────

  const numAccounts: 6 | 7 = config.numAccounts ?? 6

  // Build ordered array of allocations for each account slot 1..numAccounts,
  // using null for any slot without an allocation.
  const accountSlots = Array.from({ length: numAccounts }, (_, i) => {
    const accountNumber = i + 1
    return distribution.find((a) => a.accountNumber === accountNumber) ?? null
  })

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Page heading */}
      <h1 className="mb-8 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
        Account Distribution
      </h1>

      {/* Summary table */}
      <section aria-label="Distribution summary" className="mb-10">
        <DistributionTable distribution={distribution} numAccounts={numAccounts} />
      </section>

      {/* Account cards grid */}
      <section aria-label="Account cards">
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {accountSlots.map((allocation, idx) => {
            const accountNumber = idx + 1
            return (
              <li key={accountNumber}>
                <AccountCard
                  allocation={allocation}
                  accountNumber={accountNumber}
                />
              </li>
            )
          })}
        </ul>
      </section>

      {/* Print link */}
      <div className="mt-10 flex justify-end">
        <Link
          href="/builder/print"
          className="inline-flex items-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Print Slips →
        </Link>
      </div>
    </main>
  )
}

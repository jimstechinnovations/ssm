'use client'

/**
 * app/(builder)/print/page.tsx
 *
 * Final step of the SSM Builder: renders all account slips in a
 * print-optimised layout and provides a browser print trigger.
 *
 * Uses session state directly — no server fetch required.
 * PrintLayout injects @media print CSS that hides .no-print elements,
 * so the action bar disappears when the user prints (Requirement 9.5).
 *
 * Requirements: 9.1, 9.4, 9.5
 */

import React from 'react'
import Link from 'next/link'

import { useSession } from '@/components/session/SessionProvider'
import { PrintLayout } from '@/components/print/PrintLayout'
import { AccountPrintPage } from '@/components/print/AccountPrintPage'

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PrintPage() {
  const { state } = useSession()
  const { distribution, config, status, groupId } = state

  // ── Not generated ─────────────────────────────────────────────────────────

  if (status !== 'generated' || distribution === null) {
    return (
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-center px-4 py-24 sm:px-6 lg:px-8">
        <p className="mb-6 text-lg font-medium text-zinc-600 dark:text-zinc-400">
          Nothing to print
        </p>
        <Link
          href="/builder/accounts"
          className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          ← Back to Accounts
        </Link>
      </div>
    )
  }

  // ── Derived values ────────────────────────────────────────────────────────

  const sessionPrefix = config.sessionPrefix ?? ''

  // Sort allocations by accountNumber ascending (Requirement 9.4)
  const sortedAllocations = [...distribution].sort(
    (a, b) => a.accountNumber - b.accountNumber,
  )

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PrintLayout>
      {/* Action bar — hidden when printing via .no-print CSS rule (Requirement 9.5) */}
      <div className="no-print flex items-center gap-4 border-b border-zinc-200 px-6 py-3 dark:border-zinc-700">
        <Link
          href="/builder/accounts"
          className="text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          ← Back
        </Link>
        <button
          type="button"
          onClick={() => window.print()}
          className="ml-auto rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Print
        </button>
      </div>

      {/* One AccountPrintPage per account, ordered by accountNumber ascending */}
      {sortedAllocations.map((allocation) => (
        <AccountPrintPage
          key={allocation.accountNumber}
          allocation={allocation}
          sessionPrefix={sessionPrefix}
          groupId={groupId ?? undefined}
        />
      ))}
    </PrintLayout>
  )
}

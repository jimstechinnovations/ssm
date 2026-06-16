'use client'

/**
 * app/(builder)/matrix/page.tsx
 *
 * Step 2 of the SSM Builder: displays the 42 generated betting slips
 * grouped by tier (Core, Pivot, Chaos Anchors).
 *
 * Requirements: 8.1, 8.2
 */

import React from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

import { useSession } from '@/components/session/SessionProvider'
import { SlipCard } from '@/components/matrix/SlipCard'
import { Skeleton } from '@/components/ui/Skeleton'
import type { Slip, TierLabel } from '@/lib/ssm/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TierSection {
  tier: TierLabel
  label: string
  headingClass: string
  badgeClass: string
  slips: Slip[]
}

// ---------------------------------------------------------------------------
// Skeleton loading state
// ---------------------------------------------------------------------------

function SlipCardSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-700"
    >
      {/* Header row */}
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-5 w-14 rounded-full" />
        <Skeleton className="h-3 w-32" />
      </div>
      {/* Divider */}
      <Skeleton className="h-px w-full" />
      {/* Leg rows */}
      {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          <Skeleton className="h-3 w-4" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-5 w-8 rounded-full" />
          <Skeleton className="h-3 w-10" />
        </div>
      ))}
      {/* Divider */}
      <Skeleton className="h-px w-full" />
      {/* Footer */}
      <div className="flex gap-4">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Section heading skeleton */}
      <div className="mb-4 flex items-center gap-2">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-8 rounded-full" />
      </div>
      {/* Grid of slip card skeletons */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[1, 2, 3, 4].map((i) => (
          <SlipCardSkeleton key={i} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section heading
// ---------------------------------------------------------------------------

interface SectionHeadingProps {
  label: string
  count: number
  headingClass: string
  badgeClass: string
}

function SectionHeading({ label, count, headingClass, badgeClass }: SectionHeadingProps) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <h2 className={`text-base font-bold tracking-wide uppercase ${headingClass}`}>
        {label}
      </h2>
      <span
        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${badgeClass}`}
        aria-label={`${count} slips`}
      >
        {count}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MatrixPage() {
  const { state } = useSession()
  const { status, slips } = state

  const searchParams = useSearchParams()
  const group = searchParams.get('group')

  // ── Loading state ────────────────────────────────────────────────────────

  if (status === 'loading') {
    return <LoadingSkeleton />
  }

  // ── No matrix generated yet ───────────────────────────────────────────────

  if (status !== 'generated' || slips === null || slips.length === 0) {
    return (
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-center px-4 py-24 sm:px-6 lg:px-8">
        <p className="mb-6 text-lg font-medium text-zinc-600 dark:text-zinc-400">
          No matrix generated yet
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

  // ── Build tier sections ───────────────────────────────────────────────────

  const coreSlips = slips.filter((s) => s.tier === 'CORE')
  const pivotSlips = slips.filter((s) => s.tier === 'PIVOT')
  const chaosSlips = slips.filter((s) => s.tier === 'CHAOS')

  const sections: TierSection[] = [
    {
      tier: 'CORE',
      label: 'Core Slips',
      headingClass: 'text-blue-700 dark:text-blue-400',
      badgeClass: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
      slips: coreSlips,
    },
    {
      tier: 'PIVOT',
      label: 'Pivot Slips',
      headingClass: 'text-amber-700 dark:text-amber-400',
      badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
      slips: pivotSlips,
    },
    {
      tier: 'CHAOS',
      label: 'Chaos Anchors',
      headingClass: 'text-red-700 dark:text-red-400',
      badgeClass: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
      slips: chaosSlips,
    },
  ]

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Page title */}
      <h1 className="mb-8 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
        Generated Matrix
        <span className="ml-3 text-sm font-normal text-zinc-500 dark:text-zinc-400">
          {slips.length} slips
        </span>
      </h1>

      {/* Tier sections */}
      <div className="flex flex-col gap-12">
        {sections.map((section) => (
          <section key={section.tier} aria-label={section.label}>
            <SectionHeading
              label={section.label}
              count={section.slips.length}
              headingClass={section.headingClass}
              badgeClass={section.badgeClass}
            />

            {section.slips.length > 0 ? (
              <ul
                className="grid grid-cols-1 gap-4 lg:grid-cols-2"
                aria-label={`${section.label} list`}
              >
                {section.slips.map((slip) => (
                  <li key={slip.slipId}>
                    <SlipCard slip={slip} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                No slips in this tier.
              </p>
            )}
          </section>
        ))}
      </div>
    </main>
  )
}

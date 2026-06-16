'use client'

/**
 * components/dashboard/GroupCard.tsx
 *
 * Card component for a single SessionGroup in the dashboard.
 *
 * Displays:
 *   - Truncated Group ID (first 8 chars) with copy-to-clipboard button
 *   - GroupStatusBadge
 *   - Bookmaker + date range string
 *   - # qualifying fixtures
 *   - Dominant market name (when available)
 *   - "View Matrix" button (status = 'generated' only)
 *   - "Flush" button — calls DELETE /api/groups/{id} then router.refresh()
 *
 * Requirements: 6.6, 6.4
 */

import React, { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { GroupStatusBadge } from '@/components/dashboard/GroupStatusBadge'
import type { SessionGroup, BookmakerPlatform } from '@/lib/ssm/types'
import { OUTCOME_TO_LABEL } from '@/lib/ssm/types'

// ---------------------------------------------------------------------------
// Bookmaker label map (mirrors BookmakerSelector options)
// ---------------------------------------------------------------------------

const BOOKMAKER_LABELS: Record<BookmakerPlatform, string> = {
  betway_nigeria: 'Betway Nigeria',
  sportybet:      'SportyBet',
  stake:          'Stake',
  '1xbet':        '1xBet',
  other:          'Other',
}

// ---------------------------------------------------------------------------
// Helper: format a YYYY-MM-DD string as "DD MMM YYYY"
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.toLocaleDateString('en-GB', {
    day:   '2-digit',
    month: 'short',
    year:  'numeric',
    timeZone: 'UTC',
  })
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GroupCardProps {
  group: SessionGroup
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GroupCard({ group }: GroupCardProps) {
  const router = useRouter()

  const [copied, setCopied]   = useState(false)
  const [flushing, setFlushing] = useState(false)
  const [flushError, setFlushError] = useState<string | null>(null)

  // ── Copy full ID to clipboard ──────────────────────────────────────────

  function handleCopy() {
    navigator.clipboard.writeText(group.id).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {
      // clipboard write failed silently — nothing actionable for the user
    })
  }

  // ── Flush (DELETE) ─────────────────────────────────────────────────────

  async function handleFlush() {
    setFlushing(true)
    setFlushError(null)

    try {
      const res = await fetch(`/api/groups/${group.id}`, { method: 'DELETE' })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setFlushError((body as { error?: string }).error ?? `Request failed (${res.status})`)
        return
      }

      router.refresh()
    } catch {
      setFlushError('Network error — please try again.')
    } finally {
      setFlushing(false)
    }
  }

  // ── Derived values ─────────────────────────────────────────────────────

  const shortId    = group.id.slice(0, 8)
  const bookmaker  = BOOKMAKER_LABELS[group.bookmaker] ?? group.bookmaker
  const dateRange  = `${formatDate(group.dateFrom)} – ${formatDate(group.dateTo)}`
  const fixtureCount = group.claimedFixtureIds.length

  const dominantMarketName =
    group.dominantMarket != null
      ? OUTCOME_TO_LABEL[group.dominantMarket.dominantOutcome]
      : null

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <Card className="flex flex-col gap-4">

      {/* ── Header row: short ID + copy + status badge ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            {shortId}…
          </span>

          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? 'Copied!' : 'Copy Group ID'}
            title={copied ? 'Copied!' : 'Copy full Group ID'}
            className={[
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors duration-150',
              copied
                ? 'text-green-600 dark:text-green-400'
                : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
            ].join(' ')}
          >
            {copied ? (
              /* Checkmark icon */
              <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 00-1.414 0L8 12.586 4.707 9.293a1 1 0 00-1.414 1.414l4 4a1 1 0 001.414 0l8-8a1 1 0 000-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            ) : (
              /* Clipboard icon */
              <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <rect x="7" y="3" width="10" height="13" rx="1.5" />
                <path d="M5 7H4a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-1" />
              </svg>
            )}
            <span className="sr-only">{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>

        <GroupStatusBadge status={group.status} />
      </div>

      {/* ── Meta row: bookmaker + date range ── */}
      <div className="text-sm text-zinc-600 dark:text-zinc-400">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{bookmaker}</span>
        <span className="mx-1.5 text-zinc-400 dark:text-zinc-600">·</span>
        {dateRange}
      </div>

      {/* ── Stats row: fixture count + dominant market ── */}
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex items-baseline gap-1">
          <dt className="text-zinc-500 dark:text-zinc-400">Fixtures:</dt>
          <dd className="font-semibold text-zinc-800 dark:text-zinc-100">{fixtureCount}</dd>
        </div>

        {dominantMarketName != null && (
          <div className="flex items-baseline gap-1">
            <dt className="text-zinc-500 dark:text-zinc-400">Market:</dt>
            <dd className="font-semibold text-zinc-800 dark:text-zinc-100">{dominantMarketName}</dd>
          </div>
        )}
      </dl>

      {/* ── Flush error ── */}
      {flushError != null && (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">
          {flushError}
        </p>
      )}

      {/* ── Action buttons ── */}
      <div className="flex items-center gap-2 pt-1">
        {group.status === 'generated' && (
          <Link
            href={`/builder/matrix?group=${group.id}`}
            className={[
              'inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium',
              'bg-blue-600 text-white hover:bg-blue-700',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
              'transition-colors duration-150',
            ].join(' ')}
          >
            View Matrix
          </Link>
        )}

        <Button
          variant="danger"
          size="sm"
          loading={flushing}
          onClick={handleFlush}
          aria-label={`Flush group ${shortId}`}
        >
          Flush
        </Button>
      </div>

    </Card>
  )
}

export default GroupCard

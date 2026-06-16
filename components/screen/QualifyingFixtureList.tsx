/**
 * components/screen/QualifyingFixtureList.tsx
 *
 * Read-only ordered list of the auto-selected 8 qualifying fixtures.
 * No reorder, add, or remove controls (Requirements 3.2, 3.7).
 * Requirements: 3.2, 3.3, 3.6
 */

import React from 'react'
import type { FixtureWithGates } from '@/lib/ssm/types'

export interface QualifyingFixtureListProps {
  fixtures: FixtureWithGates[]
}

function formatKickoff(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))
  } catch { return iso }
}

export function QualifyingFixtureList({ fixtures }: QualifyingFixtureListProps) {
  const count = fixtures.length

  return (
    <div className="flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Auto-Selected Fixtures
        </h3>
        <span
          aria-live="polite"
          className={[
            'rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums',
            count === 8
              ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
          ].join(' ')}
        >
          {count} of 8
        </span>
      </div>

      {count === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400">
          No qualifying fixtures yet — run the screener to populate this list.
        </p>
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Selected qualifying fixtures">
          {fixtures.map((item, idx) => (
            <li
              key={item.fixture.id}
              className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-900"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white mt-0.5">
                {idx + 1}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {item.fixture.homeTeam}{' '}
                  <span className="font-normal text-zinc-400">vs</span>{' '}
                  {item.fixture.awayTeam}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {item.fixture.league} · {formatKickoff(item.fixture.kickoff)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export default QualifyingFixtureList

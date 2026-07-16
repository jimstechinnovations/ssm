/**
 * components/screen/QualifyingFixtureList.tsx
 *
 * Read-only ordered list of the 8 auto-selected session fixtures.
 * SSM v3 — uses ProfiledFixture (no gate rejection, every fixture is accepted).
 * Shows the fixture's profile badge alongside kickoff and teams.
 */

import React from 'react'
import type { ProfiledFixture } from '@/lib/ssm/types'

export interface QualifyingFixtureListProps {
  fixtures: ProfiledFixture[]
}

function formatKickoff(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))
  } catch { return iso }
}

const PROFILE_BADGE: Record<string, { label: string; cls: string }> = {
  GOAL_CERTAIN: { label: 'Goal Certain', cls: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
  BALANCED:     { label: 'Balanced',     cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'     },
  DEFENSIVE:    { label: 'Defensive',    cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
}

const OUTCOME_DISPLAY: Record<string, string> = {
  BTTS_YES: 'BTTS Yes', BTTS_NO: 'BTTS No',
  OVER_2_5: 'Over 2.5', UNDER_2_5: 'Under 2.5',
  DC12: 'DC 12', DC1X: 'DC 1X',
  ODD: 'Odd', EVEN: 'Even',
}

export function QualifyingFixtureList({ fixtures }: QualifyingFixtureListProps) {
  const count = fixtures.length

  return (
    <div className="flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Selected Fixtures
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
          No fixtures selected yet — run the screener to populate this list.
        </p>
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Selected session fixtures">
          {fixtures.map((item, idx) => {
            const badge  = PROFILE_BADGE[item.profile] ?? PROFILE_BADGE['BALANCED']
            const domLabel = OUTCOME_DISPLAY[item.dominantOutcome] ?? item.dominantOutcome
            return (
              <li
                key={item.fixture.id}
                className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-900"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white mt-0.5">
                  {idx + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {item.fixture.homeTeam}{' '}
                    <span className="font-normal text-zinc-400">vs</span>{' '}
                    {item.fixture.awayTeam}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {item.fixture.league} · {formatKickoff(item.fixture.kickoff)}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">
                    State 0: <span className="font-medium">{domLabel}</span>
                  </p>
                </div>
                <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                  {badge.label}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

export default QualifyingFixtureList

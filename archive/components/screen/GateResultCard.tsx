'use client'

/**
 * components/screen/GateResultCard.tsx
 *
 * SSM v3 — Fixture Profile Card.
 *
 * Replaced hard gate pass/fail display with adaptive profile classification.
 * Shows each fixture's structural profile (GOAL_CERTAIN / BALANCED / DEFENSIVE)
 * and the dominant/breakout market pair selected from its actual odds.
 *
 * No QUALIFIED/REJECTED labels — every fixture with odds is accepted.
 * The profile tells the user what kind of game this is structurally.
 */

import React, { useId, useState } from 'react'
import type { ProfiledFixture, GameSignals } from '@/lib/ssm/types'

export interface GateResultCardProps {
  /** Accept either the new ProfiledFixture or legacy FixtureWithGates shape */
  profiled?: ProfiledFixture
  // Legacy props kept for backward-compat during transition
  fixture?: ProfiledFixture['fixture']
  gateResult?: unknown
}

function formatKickoff(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))
  } catch { return iso }
}

const PROFILE_CONFIG = {
  GOAL_CERTAIN: {
    label:       'Goal Certain',
    description: 'High-scoring structure — goals near-certain, winner signal strong',
    badgeClass:  'bg-green-600',
    borderClass: 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-950/30',
  },
  BALANCED: {
    label:       'Balanced',
    description: 'Open competitive match — all outcomes live',
    badgeClass:  'bg-blue-600',
    borderClass: 'border-blue-200 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/30',
  },
  DEFENSIVE: {
    label:       'Defensive',
    description: 'Low-scoring structure — cautious game, draw live',
    badgeClass:  'bg-amber-600',
    borderClass: 'border-amber-200 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30',
  },
} as const

const OUTCOME_DISPLAY: Record<string, string> = {
  BTTS_YES:  'BTTS Yes',
  BTTS_NO:   'BTTS No',
  OVER_2_5:  'Over 2.5',
  UNDER_2_5: 'Under 2.5',
  DC12:      'DC 12',
  DC1X:      'DC 1X',
  ODD:       'Odd Goals',
  EVEN:      'Even Goals',
}

function SignalRow({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null
  const impliedPct = (100 / value).toFixed(0)
  return (
    <tr className="border-b border-zinc-50 dark:border-zinc-800 last:border-0">
      <td className="py-1 pr-3 text-xs text-zinc-500 dark:text-zinc-400">{label}</td>
      <td className="py-1 pr-3 font-mono text-xs text-zinc-700 dark:text-zinc-200">{value.toFixed(2)}</td>
      <td className="py-1 text-xs text-zinc-400 dark:text-zinc-500">{impliedPct}% implied</td>
    </tr>
  )
}

export function GateResultCard({ profiled, fixture: legacyFixture }: GateResultCardProps) {
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()

  // Support both new ProfiledFixture and legacy shape
  const data = profiled

  if (!data) {
    // Legacy fallback — fixture without profile data
    const f = legacyFixture
    if (!f) return null
    return (
      <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-700 dark:bg-zinc-900">
        <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
          {f.homeTeam} <span className="font-normal text-zinc-400">vs</span> {f.awayTeam}
        </p>
        <p className="mt-0.5 text-xs text-zinc-400">{f.league} · {formatKickoff(f.kickoff)}</p>
        <p className="mt-1 text-xs text-zinc-400">No profile data available</p>
      </div>
    )
  }

  const { fixture, profile, dominantOutcome, breakoutOutcome, dominantProb, signals } = data
  const config = PROFILE_CONFIG[profile]
  const dominantLabel  = OUTCOME_DISPLAY[dominantOutcome]  ?? dominantOutcome
  const breakoutLabel  = OUTCOME_DISPLAY[breakoutOutcome]  ?? breakoutOutcome
  const dominantPct    = (dominantProb * 100).toFixed(0)

  return (
    <div className={`rounded-xl border transition-colors ${config.borderClass}`}>

      {/* Header — collapsible toggle */}
      <button
        type="button"
        onClick={() => setExpanded(prev => !prev)}
        aria-expanded={expanded}
        aria-controls={detailId}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {fixture.homeTeam}{' '}
            <span className="font-normal text-zinc-400">vs</span>{' '}
            {fixture.awayTeam}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {fixture.league} · {formatKickoff(fixture.kickoff)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Profile badge */}
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold text-white ${config.badgeClass}`}>
            {config.label}
          </span>

          {/* Expand chevron */}
          <svg
            className={`h-4 w-4 text-zinc-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Expandable detail panel */}
      <div
        id={detailId}
        role="region"
        aria-label={`Profile details for ${fixture.homeTeam} vs ${fixture.awayTeam}`}
        hidden={!expanded}
        className="border-t border-zinc-100 px-4 pb-3 pt-2 dark:border-zinc-800"
      >
        {/* Profile description */}
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{config.description}</p>

        {/* Selected market pair */}
        <div className="mb-3 flex gap-4">
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">State 0 — Dominant</span>
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
              {dominantLabel}
              <span className="ml-1.5 text-xs font-normal text-zinc-400">({dominantPct}% implied)</span>
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">State 1 — Breakout</span>
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{breakoutLabel}</span>
          </div>
        </div>

        {/* Market signals table */}
        <table className="w-full">
          <thead>
            <tr className="text-left">
              <th className="pb-1 pr-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400" scope="col">Market</th>
              <th className="pb-1 pr-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400" scope="col">Odds</th>
              <th className="pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400" scope="col">Implied %</th>
            </tr>
          </thead>
          <tbody>
            <SignalRow label="Over 0.5"  value={signals.over05}  />
            <SignalRow label="Under 0.5" value={signals.under05} />
            <SignalRow label="BTTS Yes"  value={signals.bttsYes} />
            <SignalRow label="BTTS No"   value={signals.bttsNo}  />
            <SignalRow label="Over 2.5"  value={signals.over25}  />
            <SignalRow label="Under 2.5" value={signals.under25} />
            <SignalRow label="DC 12"     value={signals.dc12}    />
            <SignalRow label="DC 1X"     value={signals.dc1x}    />
            <SignalRow label="Odd Goals" value={signals.odd}     />
            <SignalRow label="Even Goals" value={signals.even}   />
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default GateResultCard

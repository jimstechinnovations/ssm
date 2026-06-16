'use client'

/**
 * components/screen/GateResultCard.tsx
 *
 * Displays one fixture's gate screening results with per-gate pass/fail detail.
 * Collapsible — gate rows hidden by default, expanded on click.
 * Requirements: 1.5
 */

import React, { useId, useState } from 'react'
import type { Fixture, GateEvaluation, GateResult } from '@/lib/ssm/types'

export interface GateResultCardProps {
  fixture: Fixture
  gateResult: GateResult
}

function formatKickoff(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))
  } catch { return iso }
}

function formatEvaluated(evaluated: GateEvaluation['evaluated']): string {
  if (typeof evaluated === 'number') return evaluated.toFixed(2)
  return `Yes ${evaluated.yes.toFixed(2)} / No ${evaluated.no.toFixed(2)}`
}

const GATE_LABELS: Record<string, string> = {
  G1: 'Goal Certainty (Over 0.5)',
  G2: '0-0 Elimination (Under 0.5)',
  G3: 'BTTS Live (Yes + No)',
  G4: 'Winner Signal (DC 12)',
}

export function GateResultCard({ fixture, gateResult }: GateResultCardProps) {
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()

  const isOddsUnavailable = gateResult.rejectReason === 'ODDS_UNAVAILABLE'
  const hasGates = gateResult.gates.length > 0

  return (
    <div className={[
      'rounded-xl border transition-colors',
      gateResult.qualified
        ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-950/30'
        : 'border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900',
    ].join(' ')}>

      {/* Header row — acts as the collapsible toggle */}
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
          {/* QUALIFIED / REJECTED badge — per requirement 1.5 */}
          {gateResult.qualified ? (
            <span
              className="rounded-full bg-green-600 px-2.5 py-0.5 text-xs font-bold text-white"
              aria-label="Qualified"
            >
              QUALIFIED
            </span>
          ) : (
            <span
              className="rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-bold text-white"
              aria-label="Rejected"
            >
              REJECTED
            </span>
          )}

          {/* Expand chevron */}
          <svg
            className={`h-4 w-4 text-zinc-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Expandable detail panel */}
      <div
        id={detailId}
        role="region"
        aria-label={`Gate details for ${fixture.homeTeam} vs ${fixture.awayTeam}`}
        hidden={!expanded}
        className="border-t border-zinc-100 px-4 pb-3 pt-2 dark:border-zinc-800"
      >
        {/* ODDS_UNAVAILABLE explanation — shown instead of gate table */}
        {isOddsUnavailable && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-semibold text-red-600 dark:text-red-400">ODDS_UNAVAILABLE</span>
            {' '}— odds could not be retrieved for this fixture; screening was skipped.
          </p>
        )}

        {/* Gate detail table — shown when gates are available */}
        {hasGates && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-400">
                <th className="py-1 pr-3 font-medium" scope="col">Gate</th>
                <th className="py-1 pr-3 font-medium" scope="col">Value</th>
                <th className="py-1 pr-3 font-medium" scope="col">Threshold</th>
                <th className="py-1 font-medium text-right" scope="col">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
              {gateResult.gates.map(g => (
                <tr key={g.gate}>
                  <td className="py-1 pr-3 font-medium text-zinc-600 dark:text-zinc-300">
                    {g.gate}{' '}
                    <span className="font-normal text-zinc-400">— {GATE_LABELS[g.gate]}</span>
                  </td>
                  <td className="py-1 pr-3 font-mono text-zinc-700 dark:text-zinc-200">
                    {formatEvaluated(g.evaluated)}
                  </td>
                  <td className="py-1 pr-3 text-zinc-500 dark:text-zinc-400">{g.threshold}</td>
                  <td className="py-1 text-right">
                    {g.passed ? (
                      <span
                        className="font-bold text-green-600 dark:text-green-400"
                        aria-label="Passed"
                      >✓</span>
                    ) : (
                      <span
                        className="font-bold text-red-600 dark:text-red-400"
                        aria-label="Failed"
                      >✗</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Empty state — no gates and not odds-unavailable */}
        {!isOddsUnavailable && !hasGates && (
          <p className="text-xs text-zinc-400">No gate data available.</p>
        )}
      </div>
    </div>
  )
}

export default GateResultCard

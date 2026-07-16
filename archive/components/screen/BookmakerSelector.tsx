'use client'

/**
 * components/screen/BookmakerSelector.tsx
 *
 * Controlled select for choosing the bookmaker platform.
 * Requirements: 2.1, 2.5
 */

import React from 'react'
import type { BookmakerPlatform } from '@/lib/ssm/types'

export interface BookmakerSelectorProps {
  value: BookmakerPlatform | ''
  onChange: (value: BookmakerPlatform | '') => void
  showError?: boolean
}

const OPTIONS: { value: BookmakerPlatform; label: string }[] = [
  { value: 'betway_nigeria', label: 'Betway Nigeria' },
  { value: 'sportybet',      label: 'SportyBet' },
  { value: 'stake',          label: 'Stake' },
  { value: '1xbet',          label: '1xBet' },
  { value: 'other',          label: 'Other' },
]

export function BookmakerSelector({ value, onChange, showError = false }: BookmakerSelectorProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="bookmaker-select" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Bookmaker
      </label>
      <select
        id="bookmaker-select"
        value={value}
        onChange={e => onChange(e.target.value as BookmakerPlatform | '')}
        className={[
          'w-full rounded-lg border px-3 py-2 text-sm',
          'bg-white dark:bg-zinc-900',
          'text-zinc-900 dark:text-zinc-100',
          'focus:outline-none focus:ring-2 focus:ring-blue-500',
          showError && value === ''
            ? 'border-red-500 dark:border-red-400'
            : 'border-zinc-300 dark:border-zinc-600',
        ].filter(Boolean).join(' ')}
        aria-required="true"
        aria-invalid={showError && value === ''}
        aria-describedby={showError && value === '' ? 'bookmaker-error' : undefined}
      >
        <option value="" disabled>Select a bookmaker…</option>
        {OPTIONS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {showError && value === '' && (
        <p id="bookmaker-error" className="text-xs text-red-600 dark:text-red-400" role="alert">
          Please select a bookmaker before searching.
        </p>
      )}
    </div>
  )
}

export default BookmakerSelector

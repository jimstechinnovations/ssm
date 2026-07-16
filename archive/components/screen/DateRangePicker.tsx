'use client'

/**
 * components/screen/DateRangePicker.tsx
 *
 * Date range picker: fixed start = today, adjustable end (today+1 to today+7).
 * Requirements: 2.3, 2.4, 2.6
 */

import React, { useEffect, useState } from 'react'

export interface DateRangePickerProps {
  onChange: (dateFrom: string, dateTo: string) => void
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDays(base: string, days: number): string {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export function DateRangePicker({ onChange }: DateRangePickerProps) {
  const today = todayStr()
  const [dateTo, setDateTo] = useState(addDays(today, 1))
  const [error, setError] = useState<string | null>(null)

  // Notify parent on mount with defaults
  useEffect(() => {
    onChange(today, addDays(today, 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleChangeTo(val: string) {
    const maxTo = addDays(today, 7)
    if (val < today) {
      setError('End date cannot be before today.')
      return
    }
    if (val > maxTo) {
      setError('End date cannot be more than 7 days from today.')
      return
    }
    setError(null)
    setDateTo(val)
    onChange(today, val)
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
      {/* From — read-only today */}
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <label htmlFor="date-from" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          From
        </label>
        <input
          id="date-from"
          type="date"
          value={today}
          readOnly
          className="w-full rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 cursor-default"
          aria-label="Start date (today)"
        />
      </div>

      {/* To — adjustable */}
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <label htmlFor="date-to" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          To <span className="text-xs font-normal text-zinc-400">(max 7 days)</span>
        </label>
        <input
          id="date-to"
          type="date"
          value={dateTo}
          min={addDays(today, 1)}
          max={addDays(today, 7)}
          onChange={e => handleChangeTo(e.target.value)}
          className={[
            'w-full rounded-lg border px-3 py-2 text-sm',
            'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100',
            'focus:outline-none focus:ring-2 focus:ring-blue-500',
            error ? 'border-red-500' : 'border-zinc-300 dark:border-zinc-600',
          ].join(' ')}
          aria-invalid={!!error}
          aria-describedby={error ? 'date-to-error' : undefined}
        />
        {error && (
          <p id="date-to-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

export default DateRangePicker

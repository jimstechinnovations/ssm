'use client'

/**
 * components/screen/BankrollInput.tsx
 *
 * Numeric input with ₦ currency prefix for entering the session bankroll.
 * Emits onChange(value) and onValidChange(isValid) to allow the parent to
 * gate the "Confirm & Generate" button.
 * Requirements: 5.1, 5.3, 5.5
 */

import React, { useState } from 'react'

export interface BankrollInputProps {
  value?: number
  onChange: (value: number) => void
  onValidChange?: (isValid: boolean) => void
  disabled?: boolean
}

const DEFAULT_VALUE = 10000

export function BankrollInput({
  value,
  onChange,
  onValidChange,
  disabled = false,
}: BankrollInputProps) {
  // Internal string state so we can handle partial / empty input gracefully
  const [internalValue, setInternalValue] = useState<string>(
    value !== undefined ? String(value) : String(DEFAULT_VALUE),
  )

  const parsedValue = parseInt(internalValue, 10)
  const isValid = !Number.isNaN(parsedValue) && parsedValue > 0

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value
    setInternalValue(raw)

    const parsed = parseInt(raw, 10)
    const valid = !Number.isNaN(parsed) && parsed > 0

    onValidChange?.(valid)

    if (valid) {
      onChange(parsed)
    }
  }

  const showError = !isValid

  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor="bankroll-input"
        className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
      >
        Bankroll
      </label>

      {/* Input group: ₦ prefix + number field */}
      <div
        className={[
          'flex items-stretch overflow-hidden rounded-lg border',
          showError
            ? 'border-red-500 dark:border-red-400'
            : 'border-zinc-300 dark:border-zinc-600',
          disabled ? 'opacity-50' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {/* Currency prefix — non-interactive */}
        <span
          aria-hidden="true"
          className="flex items-center border-r border-zinc-300 bg-zinc-100 px-3 text-sm font-medium text-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
        >
          ₦
        </span>

        <input
          id="bankroll-input"
          type="number"
          min={1}
          value={internalValue}
          onChange={handleChange}
          disabled={disabled}
          className={[
            'w-full bg-white px-3 py-2 text-sm',
            'text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100',
            'focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500',
            // Remove browser spinner arrows for a cleaner look
            '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-required="true"
          aria-invalid={showError}
          aria-describedby={showError ? 'bankroll-error' : undefined}
        />
      </div>

      {showError && (
        <p
          id="bankroll-error"
          className="text-xs text-red-600 dark:text-red-400"
          role="alert"
        >
          Please enter a bankroll amount greater than zero.
        </p>
      )}
    </div>
  )
}

export default BankrollInput

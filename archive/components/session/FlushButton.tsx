'use client'

/**
 * components/session/FlushButton.tsx
 *
 * Calls useSession().flush() on click and shows a loading spinner
 * while the flush is in progress.
 *
 * Requirements: 5.5
 */

import { useSession } from '@/components/session/SessionProvider'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FlushButton() {
  const { state, flush } = useSession()
  const isFlushing = state.status === 'flushing'

  return (
    <button
      type="button"
      onClick={flush}
      disabled={isFlushing}
      aria-disabled={isFlushing}
      aria-label="Flush current session"
      className={[
        'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium',
        'text-red-600 hover:bg-red-50 hover:text-red-700',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2',
        'transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'dark:text-red-400 dark:hover:bg-red-950 dark:hover:text-red-300',
      ].join(' ')}
    >
      {isFlushing ? (
        <>
          {/* Inline spinner */}
          <svg
            className="h-3.5 w-3.5 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            />
          </svg>
          Flushing…
        </>
      ) : (
        'Flush Session'
      )}
    </button>
  )
}

export default FlushButton

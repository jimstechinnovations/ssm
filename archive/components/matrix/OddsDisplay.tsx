/**
 * components/matrix/OddsDisplay.tsx
 *
 * Presentational component that renders decimal odds formatted to 2 decimal places.
 *
 * Requirements: 8.2
 */

import React from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OddsDisplayProps {
  odds: number
  className?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OddsDisplay({ odds, className }: OddsDisplayProps) {
  return (
    <span className={['font-mono', className].filter(Boolean).join(' ')}>
      {odds.toFixed(2)}
    </span>
  )
}

export default OddsDisplay

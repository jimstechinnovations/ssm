/**
 * components/ui/Card.tsx
 *
 * Simple card wrapper — white background, rounded corners, shadow, padding.
 *
 * Requirements: 8.1
 */

import React from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CardProps {
  children?: React.ReactNode
  className?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Card({ children, className = '' }: CardProps) {
  return (
    <div
      className={[
        'rounded-xl bg-white p-6 shadow',
        'dark:bg-zinc-900',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}

export default Card

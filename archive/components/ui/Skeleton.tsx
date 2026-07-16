/**
 * components/ui/Skeleton.tsx
 *
 * Animated loading placeholder.
 * Pass className to control width and height (e.g. "w-32 h-4").
 *
 * Requirements: 8.1
 */

import React from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkeletonProps {
  className?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={[
        'animate-pulse rounded bg-zinc-200 dark:bg-zinc-700',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  )
}

export default Skeleton

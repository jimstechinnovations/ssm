/**
 * components/ui/Badge.tsx
 *
 * Colour-coded badge for SSM selection types and generic labels.
 *
 * Variant → background colour mapping:
 *   CORE    → blue
 *   PIVOT   → amber/yellow
 *   CHAOS   → red
 *   default → gray
 *
 * Requirements: 4.6, 8.1
 */

import React from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BadgeVariant = 'CORE' | 'PIVOT' | 'CHAOS' | 'default'

export interface BadgeProps {
  variant?: BadgeVariant
  children?: React.ReactNode
  className?: string
}

// ---------------------------------------------------------------------------
// Style map
// ---------------------------------------------------------------------------

const variantClasses: Record<BadgeVariant, string> = {
  CORE: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  PIVOT: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  CHAOS: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  default: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Badge({ variant = 'default', children, className = '' }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
        variantClasses[variant],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  )
}

export default Badge

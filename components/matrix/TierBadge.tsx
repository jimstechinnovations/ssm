/**
 * components/matrix/TierBadge.tsx
 *
 * Presentational component that renders a coloured badge for a TierLabel.
 *
 * Requirements: 8.1
 */

import React from 'react'
import { Badge } from '@/components/ui/Badge'
import type { TierLabel } from '@/lib/ssm/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TierBadgeProps {
  tier: TierLabel
  className?: string
}

// ---------------------------------------------------------------------------
// Label map
// ---------------------------------------------------------------------------

const tierLabels: Record<TierLabel, string> = {
  CORE:   'Core',
  PIVOT:  'Pivot',
  BRIDGE: 'Bridge',
  CHAOS:  'Chaos',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TierBadge({ tier, className }: TierBadgeProps) {
  return (
    <Badge variant={tier} className={className}>
      {tierLabels[tier]}
    </Badge>
  )
}

export default TierBadge

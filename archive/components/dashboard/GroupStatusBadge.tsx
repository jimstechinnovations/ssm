/**
 * components/dashboard/GroupStatusBadge.tsx
 *
 * Color-coded badge for SessionGroup status values.
 *
 * Status → colour mapping:
 *   screening → amber
 *   generated → green
 *   printed   → blue
 *
 * Requirements: 6.6
 */

import React from 'react'
import { Badge } from '@/components/ui/Badge'
import type { SessionGroupStatus } from '@/lib/ssm/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GroupStatusBadgeProps {
  status: SessionGroupStatus
}

// ---------------------------------------------------------------------------
// Style map
// ---------------------------------------------------------------------------

const statusClasses: Record<SessionGroupStatus, string> = {
  screening:
    'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  generated:
    'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  printed:
    'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
}

const statusLabels: Record<SessionGroupStatus, string> = {
  screening: 'Screening',
  generated: 'Generated',
  printed:   'Printed',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GroupStatusBadge({ status }: GroupStatusBadgeProps) {
  return (
    <Badge className={statusClasses[status]}>
      {statusLabels[status]}
    </Badge>
  )
}

export default GroupStatusBadge

'use client'

/**
 * components/dashboard/NewGroupButton.tsx
 *
 * Client component button that navigates to /builder/screen.
 *
 * Requirements: 6.6
 */

import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'

export function NewGroupButton() {
  const router = useRouter()

  return (
    <Button
      variant="primary"
      size="md"
      onClick={() => router.push('/builder/screen')}
    >
      + New Group
    </Button>
  )
}

export default NewGroupButton

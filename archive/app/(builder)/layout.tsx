import Link from 'next/link'
import { FlushButton } from '@/components/session/FlushButton'

/**
 * app/(builder)/layout.tsx
 *
 * Builder shell layout — wraps all builder pages with a sticky stepper header.
 * Server Component (no 'use client').
 *
 * Requirements: 5.5, 6.6
 */

export default function BuilderLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      {/* Sticky header */}
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/80">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6 lg:px-8">
          {/* Logo */}
          <Link
            href="/builder/dashboard"
            className="shrink-0 text-sm font-bold text-zinc-900 dark:text-zinc-100"
          >
            SSM Builder
          </Link>

          {/* Stepper nav — mobile: abbreviated, desktop: full labels */}
          <nav aria-label="Builder steps" className="flex flex-1 items-center justify-center gap-1 sm:gap-2">
            <StepLink href="/builder/dashboard" step={1} label="Dashboard" />
            <StepDivider />
            <StepLink href="/builder/pedlas" step={2} label="PEDLAS" />
            <StepDivider />
            <StepLink href="/builder/screen" step={3} label="Screen" />
            <StepDivider />
            <StepLink href="/builder/matrix" step={4} label="Matrix" />
            <StepDivider />
            <StepLink href="/builder/accounts" step={5} label="Accounts" />
            <StepDivider />
            <StepLink href="/builder/print" step={6} label="Print" />
          </nav>

          {/* Flush button — client component, Next.js handles the boundary */}
          <div className="shrink-0">
            <FlushButton />
          </div>
        </div>
      </header>

      {/* Main content area */}
      <main className="flex-1">{children}</main>
    </div>
  )
}

function StepLink({ href, step, label }: { href: string; step: number; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 sm:text-sm"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-bold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300">
        {step}
      </span>
      <span className="hidden sm:inline">{label}</span>
    </Link>
  )
}

function StepDivider() {
  return <span className="text-zinc-300 dark:text-zinc-600">›</span>
}

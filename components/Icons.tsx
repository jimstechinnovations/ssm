/** Small inline SVG icon set — no emoji, crisp at any size, currentColor-tinted. */
import React from 'react'

type P = { className?: string }
const svg = (path: React.ReactNode, extra?: Partial<React.SVGProps<SVGSVGElement>>) => ({ className }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    className={className} aria-hidden="true" {...extra}>{path}</svg>
)

export const ArrowLeft = svg(<path d="M19 12H5M12 19l-7-7 7-7" />)
export const Plus = svg(<path d="M12 5v14M5 12h14" />)
export const Play = svg(<path d="M6 4l14 8-14 8V4z" fill="currentColor" stroke="none" />)
export const StopIcon = svg(<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />)
export const Refresh = svg(<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />)
export const Rocket = svg(<path d="M5 13l4 4M14.5 4.5c3 0 5 2 5 5-1.5 5-6 8-11 9l-3-3c1-5 4-9.5 9-11zM9 15l-2 5 5-2" />)
export const Copy = svg(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>)
export const Check = svg(<path d="M20 6L9 17l-5-5" />)
export const XMark = svg(<path d="M18 6L6 18M6 6l12 12" />)
export const Monitor = svg(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>)
export const Layers = svg(<><path d="M12 2l9 5-9 5-9-5 9-5z" /><path d="M3 12l9 5 9-5M3 17l9 5 9-5" /></>)
export const Bolt = svg(<path d="M13 2L3 14h7v8l10-12h-7V2z" fill="currentColor" stroke="none" />)
export const Download = svg(<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />)

/** Spinning loader. */
export function Spinner({ className = 'h-4 w-4' }: P) {
  return (
    <svg viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" fill="none" className="opacity-20" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  )
}

/** Full-page centred loader with a label. */
export function Loading({ label }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-zinc-500 dark:text-zinc-400">
      <Spinner className="h-7 w-7" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  )
}

/** Coloured status dot. */
export function Dot({ tone = 'zinc', className = '' }: { tone?: 'green' | 'red' | 'amber' | 'blue' | 'zinc'; className?: string }) {
  const c = { green: 'bg-green-500', red: 'bg-red-500', amber: 'bg-amber-500', blue: 'bg-blue-500', zinc: 'bg-zinc-400' }[tone]
  return <span className={`inline-block h-2 w-2 rounded-full ${c} ${className}`} />
}

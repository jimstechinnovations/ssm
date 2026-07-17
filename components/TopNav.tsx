'use client'

/** Global top navigation — one consistent header across every page (brand + primary links). */
import React from 'react'
import { usePathname } from 'next/navigation'

const links = [
  { href: '/', label: 'Dashboard' },
  { href: '/bet-manager', label: 'Bet Manager' },
  { href: '/config', label: 'Config' },
]

export default function TopNav() {
  const path = usePathname() || '/'
  const active = (href: string) => href === '/' ? path === '/' || path.startsWith('/sessions') : path.startsWith(href)
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/85 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
      <div className="mx-auto flex h-14 max-w-4xl items-center gap-0.5 px-3 sm:gap-1 sm:px-6">
        <a href="/" className="mr-1 flex items-center gap-2 font-bold tracking-tight text-zinc-900 sm:mr-3 dark:text-zinc-100">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-zinc-900 text-xs font-black text-white dark:bg-zinc-100 dark:text-zinc-900">P</span>
          <span className="hidden sm:inline">PEDLA</span>
        </a>
        <nav className="flex items-center gap-0.5 text-sm">
          {links.map(l => (
            <a key={l.href} href={l.href}
              className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 font-medium transition-colors sm:px-3 ${active(l.href)
                ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-900'}`}>
              {l.label}
            </a>
          ))}
        </nav>
        <a href="/bet-manager" className="ml-auto whitespace-nowrap rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
          + New<span className="hidden sm:inline"> session</span>
        </a>
      </div>
    </header>
  )
}

'use client'

/** Global top navigation — full links on desktop, a hamburger menu on mobile (so the bar never
 *  overflows the viewport). One consistent header on every page. */
import React, { useState } from 'react'
import { usePathname } from 'next/navigation'
import { Plus, Bolt, Menu, XMark } from '@/components/Icons'

const links = [
  { href: '/', label: 'Dashboard' },
  { href: '/bet-manager', label: 'Bet Manager' },
  { href: '/placements', label: 'Reports' },
  { href: '/config', label: 'Config' },
]

export default function TopNav() {
  const path = usePathname() || '/'
  const [open, setOpen] = useState(false)
  const active = (href: string) => href === '/' ? path === '/' || path.startsWith('/sessions') : path.startsWith(href)
  const linkCls = (href: string) => `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${active(href)
    ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
    : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-900'}`

  return (
    <header className="no-print sticky top-0 z-30 border-b border-zinc-200 bg-white/85 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
      <div className="mx-auto flex h-14 max-w-4xl items-center gap-2 px-4 sm:px-6">
        <a href="/" className="flex items-center gap-2 font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"><Bolt className="h-3.5 w-3.5" /></span>
          PEDLA
        </a>

        {/* desktop links */}
        <nav className="ml-3 hidden items-center gap-0.5 sm:flex">
          {links.map(l => <a key={l.href} href={l.href} className={linkCls(l.href)}>{l.label}</a>)}
        </nav>
        <a href="/bet-manager" className="ml-auto hidden items-center gap-1 whitespace-nowrap rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-zinc-700 sm:inline-flex dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
          <Plus className="h-4 w-4" /> New session
        </a>

        {/* mobile hamburger */}
        <button onClick={() => setOpen(o => !o)} aria-label="Menu" aria-expanded={open}
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 text-zinc-700 hover:bg-zinc-100 sm:hidden dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
          {open ? <XMark className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* mobile dropdown */}
      {open && (
        <nav className="border-t border-zinc-200 bg-white sm:hidden dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto flex max-w-4xl flex-col gap-1 px-4 py-2">
            {links.map(l => <a key={l.href} href={l.href} onClick={() => setOpen(false)} className={linkCls(l.href)}>{l.label}</a>)}
            <a href="/bet-manager" onClick={() => setOpen(false)} className="mt-1 inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
              <Plus className="h-4 w-4" /> New session
            </a>
          </div>
        </nav>
      )}
    </header>
  )
}

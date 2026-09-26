'use client'

/** Global top navigation — full links on desktop, a menu on mobile (the bar never overflows).
 *  Four places, in the order you use them: see sessions → build one → check results → settings. */
import React, { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Plus, Bolt, Menu, XMark } from '@/components/Icons'

const links = [
  { href: '/', label: 'Sessions' },
  { href: '/bet-manager', label: 'New session' },
  { href: '/placements', label: 'Results' },
  { href: '/config', label: 'Settings' },
]

export default function TopNav() {
  const path = usePathname() || '/'
  const [open, setOpen] = useState(false)
  const active = (href: string) => href === '/' ? path === '/' || path.startsWith('/sessions') : path.startsWith(href)
  const linkCls = (href: string) => `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${active(href)
    ? 'bg-zinc-900/[0.06] text-zinc-900 dark:bg-white/10 dark:text-white'
    : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'}`

  return (
    <header className="no-print sticky top-0 z-30 border-b border-zinc-200/80 bg-white/80 backdrop-blur-md dark:border-zinc-800/80 dark:bg-zinc-950/80">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"><Bolt className="h-3.5 w-3.5" /></span>
          PEDLA
        </Link>

        <nav className="ml-4 hidden items-center gap-0.5 sm:flex">
          {links.map(l => <Link key={l.href} href={l.href} className={linkCls(l.href)}>{l.label}</Link>)}
        </nav>
        <Link href="/bet-manager" className="ml-auto hidden h-8 items-center gap-1 whitespace-nowrap rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-700 sm:inline-flex dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
          <Plus className="h-4 w-4" /> New session
        </Link>

        <button onClick={() => setOpen(o => !o)} aria-label="Menu" aria-expanded={open}
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 text-zinc-700 hover:bg-zinc-100 sm:hidden dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
          {open ? <XMark className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <nav className="border-t border-zinc-200 bg-white sm:hidden dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-2">
            {links.map(l => <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className={linkCls(l.href)}>{l.label}</Link>)}
          </div>
        </nav>
      )}
    </header>
  )
}

'use client'

/**
 * components/ui.tsx — the small design kit every page uses, so the app reads as one product:
 * one card, one button family, one badge, one stat tile, one banner. Neutral zinc surfaces, a single
 * emerald accent for "money / go", semantic red/amber only for risk. Light + dark.
 */

import React from 'react'
import { Spinner } from './Icons'

export const cx = (...c: unknown[]) => c.filter(x => typeof x === 'string' && x).join(' ')

export const naira = (n?: number | null) => n == null || !Number.isFinite(n) ? '—' : '₦' + Math.round(n).toLocaleString()
export const pct = (p?: number | null, dp = 1) => p == null || !Number.isFinite(p) ? '—' : `${(100 * p).toFixed(dp)}%`
export const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
export const kickoff = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

// ── layout ─────────────────────────────────────────────────────────────────────
/** Every page sits in the same column as the top navigation (max-w-6xl), so nothing floats outside it.
 *  `wide` is kept for old callers; it no longer changes the width. */
export function Page({ children }: { children: React.ReactNode; wide?: boolean }) {
  return <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6 sm:px-6 sm:pt-8">{children}</div>
}

export function PageHeader({ title, subtitle, actions, back, badge }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; back?: { href: string; label: string; current?: string }; badge?: React.ReactNode }) {
  return (
    <header className="mb-6">
      {back && (
        <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1.5 text-sm text-zinc-500">
          <a href={back.href} className="hover:text-zinc-900 dark:hover:text-zinc-200">{back.label}</a>
          <span aria-hidden className="text-zinc-300 dark:text-zinc-600">/</span>
          <span className="text-zinc-700 dark:text-zinc-300">{typeof title === 'string' ? title : back.current ?? ''}</span>
        </nav>
      )}
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h1>
            {badge}
          </div>
          {subtitle && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}

export function Card({ title, subtitle, action, children, className, pad = true }: { title?: React.ReactNode; subtitle?: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx('rounded-2xl border border-zinc-200 bg-white shadow-sm shadow-zinc-900/[0.03] dark:border-zinc-800 dark:bg-zinc-900', className)}>
      {(title || action) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-5 py-3.5 dark:border-zinc-800">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className={pad ? 'p-5' : ''}>{children}</div>
    </section>
  )
}

// ── controls ───────────────────────────────────────────────────────────────────
type BtnVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'go'
const BTN: Record<BtnVariant, string> = {
  primary: 'bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white',
  go: 'bg-emerald-600 text-white hover:bg-emerald-700',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  secondary: 'border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800',
  ghost: 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
}
export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: React.ReactNode }) {
  const sz = size === 'sm' ? 'h-8 px-3 text-xs' : size === 'lg' ? 'h-11 px-5 text-sm' : 'h-9 px-3.5 text-sm'
  return (
    <button {...rest} disabled={rest.disabled || loading}
      className={cx('inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-45', sz, BTN[variant], className)}>
      {loading ? <Spinner className="h-4 w-4" /> : icon}{children}
    </button>
  )
}
export function LinkButton({ href, variant = 'secondary', size = 'md', children, className, target }: { href: string; variant?: BtnVariant; size?: 'sm' | 'md' | 'lg'; children: React.ReactNode; className?: string; target?: string }) {
  const sz = size === 'sm' ? 'h-8 px-3 text-xs' : size === 'lg' ? 'h-11 px-5 text-sm' : 'h-9 px-3.5 text-sm'
  return <a href={href} target={target} rel={target ? 'noopener' : undefined} className={cx('inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition', sz, BTN[variant], className)}>{children}</a>
}

export const inputCls = 'h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500'

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{hint}</span>}
    </label>
  )
}

// ── display ────────────────────────────────────────────────────────────────────
export type Tone = 'green' | 'red' | 'amber' | 'blue' | 'zinc'
const BADGE: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-400/20',
  red: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-400/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-400/20',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-400/20',
  zinc: 'bg-zinc-100 text-zinc-600 ring-zinc-500/15 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-400/15',
}
export function Badge({ tone = 'zinc', children, className, dot }: { tone?: Tone; children: React.ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', BADGE[tone], className)}>
      {dot && <span className={cx('h-1.5 w-1.5 rounded-full', { green: 'bg-emerald-500', red: 'bg-red-500', amber: 'bg-amber-500', blue: 'bg-sky-500', zinc: 'bg-zinc-400' }[tone])} />}
      {children}
    </span>
  )
}

/** Slip / session status → badge tone + label, used everywhere so statuses look identical app-wide. */
export const STATUS: Record<string, { tone: Tone; label: string }> = {
  pending: { tone: 'zinc', label: 'Pending' }, placing: { tone: 'amber', label: 'Placing' },
  submitting: { tone: 'amber', label: 'Submitting' }, verify: { tone: 'amber', label: 'Check bet history' },
  placed: { tone: 'blue', label: 'Placed' }, won: { tone: 'green', label: 'Won' }, lost: { tone: 'zinc', label: 'Lost' },
  failed: { tone: 'red', label: 'Failed' }, skipped: { tone: 'zinc', label: 'Skipped' },
  building: { tone: 'blue', label: 'Building' }, done: { tone: 'green', label: 'Done' }, stopped: { tone: 'zinc', label: 'Stopped' },
  running: { tone: 'amber', label: 'Placing' }, stalled: { tone: 'red', label: 'Stalled' }, complete: { tone: 'green', label: 'All placed' },
  ready: { tone: 'blue', label: 'Ready to place' }, expired: { tone: 'zinc', label: 'Expired — games started' },
}
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: 'zinc' as Tone, label: status }
  return <Badge tone={s.tone} dot>{s.label}</Badge>
}

export function Stat({ label, value, hint, tone, big }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'pos' | 'neg' | 'accent'; big?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={cx('mt-1 font-semibold tabular-nums tracking-tight', big ? 'text-2xl' : 'text-lg',
        tone === 'pos' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'neg' ? 'text-red-600 dark:text-red-400' : tone === 'accent' ? 'text-zinc-900 dark:text-white' : 'text-zinc-900 dark:text-zinc-100')}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</div>}
    </div>
  )
}

export function Banner({ tone = 'info', title, children, action }: { tone?: 'ok' | 'warn' | 'info' | 'error' | 'muted'; title?: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode }) {
  const cls = {
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200',
    warn: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100',
    error: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200',
    info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200',
    muted: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
  }[tone]
  return (
    <div className={cx('flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-start', cls)}>
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cx('leading-relaxed', title && 'mt-0.5 opacity-90')}>{children}</div>}
      </div>
      {action}
    </div>
  )
}

/** Segmented progress bar: [{value, className}] over a total. */
export function Progress({ total, parts }: { total: number; parts: { value: number; className: string; label?: string }[] }) {
  const t = Math.max(1, total)
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
      {parts.map((p, i) => <div key={i} title={p.label} className={cx('h-full transition-all duration-500', p.className)} style={{ width: `${(100 * p.value) / t}%` }} />)}
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: string; count?: number | string }[] }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)}
          className={cx('-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition',
            value === t.id ? 'border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-50' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}>
          {t.label}{t.count != null && <span className="rounded-full bg-zinc-100 px-1.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Empty({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
      <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{title}</div>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Modal({ onClose, title, children, headerExtra }: { onClose: () => void; title: React.ReactNode; children: React.ReactNode; headerExtra?: React.ReactNode }) {
  React.useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-zinc-950/50 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl dark:bg-zinc-900">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
          {headerExtra}
          <button onClick={onClose} aria-label="Close" className="ml-auto rounded-lg px-2 py-1 text-lg leading-none text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800">×</button>
        </div>
        <div className="overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

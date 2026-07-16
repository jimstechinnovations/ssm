// lib/books/config-store.ts
// Server-side, CRUD-able per-book configuration (Supabase `book_configs`) — replaces the local
// placement.config.json. Nothing local: the website is the single source of truth (pedlas_v3.md §8).
//
// The effective config for a book = registry adapter defaults (label, currency, min stake, caps,
// feed-verified flag) OVERLAID with its book_configs row, if any. A row may also exist for a
// "config-only" book that has no adapter yet (registered=false) — you can manage its numbers now
// and add the feed/placement code later.
//
// Degrades gracefully: if migration 006 isn't applied the reads return registry defaults so the
// app still runs (same soft-fail contract as lib/placement/store.ts).

import 'server-only'

import { createServerClient } from '../supabase/server'
import { listBooks } from './registry'
import type { BookPlacementConfig } from '../placement/config'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One book's full, effective configuration (client-safe — never contains credentials). */
export interface BookConfig {
  bookId: string
  label: string
  currency: string
  minStake: number
  maxPayout: number
  enabled: boolean
  boost: unknown | null          // verified Win-Boost table, or null (= no boost)
  delayMinSec: number
  delayMaxSec: number
  kickoffCutoffMin: number
  dailyBudgetCap: number
  registered: boolean            // an adapter exists in the registry (can pull odds / place)
  feedVerified: boolean          // the adapter's live feed works today
  credentialsConfigured: boolean // placement env vars are set
}

/** Defaults for a book with no saved row (mirrors the old DEFAULT_BOOK_CONFIG numbers). */
function defaults(bookId: string): Pick<BookConfig, 'enabled' | 'delayMinSec' | 'delayMaxSec' | 'kickoffCutoffMin' | 'dailyBudgetCap' | 'boost'> {
  return { enabled: false, delayMinSec: 45, delayMaxSec: 180, kickoffCutoffMin: 20, dailyBudgetCap: 5000, boost: null }
}

function rowToConfig(r: any, base?: Partial<BookConfig>): BookConfig {
  return {
    bookId:          r.book_id,
    label:           r.label ?? base?.label ?? r.book_id,
    currency:        r.currency ?? base?.currency ?? 'NGN',
    minStake:        r.min_stake == null ? (base?.minStake ?? 10) : Number(r.min_stake),
    maxPayout:       r.max_payout == null ? (base?.maxPayout ?? 50_000_000) : Number(r.max_payout),
    enabled:         Boolean(r.enabled),
    boost:           r.boost_json ?? null,
    delayMinSec:     r.delay_min_sec ?? 45,
    delayMaxSec:     r.delay_max_sec ?? 180,
    kickoffCutoffMin: r.kickoff_cutoff_min ?? 20,
    dailyBudgetCap:  r.daily_budget_cap == null ? 5000 : Number(r.daily_budget_cap),
    registered:      base?.registered ?? false,
    feedVerified:    base?.feedVerified ?? false,
    credentialsConfigured: base?.credentialsConfigured ?? false,
  }
}

/** Registry metadata keyed by id, used as the merge base. */
function registryBase(): Map<string, Partial<BookConfig>> {
  const m = new Map<string, Partial<BookConfig>>()
  for (const b of listBooks()) {
    m.set(b.id, {
      label: b.label, currency: b.currency, minStake: b.minStake, maxPayout: b.maxPayout,
      registered: true, feedVerified: b.feedVerified, credentialsConfigured: b.credentialsConfigured,
    })
  }
  return m
}

/** All book configs: every registered book (defaults or its row) + any config-only rows. */
export async function listBookConfigs(): Promise<BookConfig[]> {
  const base = registryBase()
  const rows = new Map<string, any>()
  try {
    const supabase = createServerClient()
    const { data, error } = await (supabase.from('book_configs').select('*')) as { data: any[] | null; error: unknown }
    if (!error && data) for (const r of data) rows.set(r.book_id, r)
  } catch { /* soft-fail → registry defaults only */ }

  const out: BookConfig[] = []
  const ids = new Set<string>([...base.keys(), ...rows.keys()])
  for (const id of ids) {
    const b = base.get(id)
    const r = rows.get(id)
    if (r) out.push(rowToConfig(r, b))
    else out.push({ bookId: id, ...defaults(id), ...(b as any), minStake: b?.minStake ?? 10, maxPayout: b?.maxPayout ?? 50_000_000, label: b?.label ?? id, currency: b?.currency ?? 'NGN', registered: b?.registered ?? false, feedVerified: b?.feedVerified ?? false, credentialsConfigured: b?.credentialsConfigured ?? false } as BookConfig)
  }
  return out.sort((a, b) => (a.registered === b.registered ? a.label.localeCompare(b.label) : a.registered ? -1 : 1))
}

/** One book's effective config (row overlaid on registry defaults). */
export async function getBookConfig(bookId: string): Promise<BookConfig> {
  const all = await listBookConfigs()
  const found = all.find(c => c.bookId === bookId)
  if (found) return found
  // Unknown id, no row, not registered → bare defaults so callers never crash.
  return { bookId, label: bookId, currency: 'NGN', minStake: 10, maxPayout: 50_000_000, ...defaults(bookId), registered: false, feedVerified: false, credentialsConfigured: false }
}

/** Fields a client may create/update on a book config. */
export interface BookConfigPatch {
  bookId: string
  label?: string
  currency?: string
  minStake?: number
  maxPayout?: number
  enabled?: boolean
  boost?: unknown | null
  delayMinSec?: number
  delayMaxSec?: number
  kickoffCutoffMin?: number
  dailyBudgetCap?: number
}

/** Create or update a book config row. Returns the merged effective config, or null on failure. */
export async function upsertBookConfig(patch: BookConfigPatch): Promise<BookConfig | null> {
  try {
    const supabase = createServerClient()
    const base = registryBase().get(patch.bookId)
    const row: Record<string, unknown> = {
      book_id: patch.bookId,
      label: patch.label ?? base?.label ?? patch.bookId,
      updated_at: new Date().toISOString(),
    }
    const set = (k: string, v: unknown) => { if (v !== undefined) row[k] = v }
    set('currency', patch.currency)
    set('min_stake', patch.minStake)
    set('max_payout', patch.maxPayout)
    set('enabled', patch.enabled)
    set('boost_json', patch.boost)
    set('delay_min_sec', patch.delayMinSec)
    set('delay_max_sec', patch.delayMaxSec)
    set('kickoff_cutoff_min', patch.kickoffCutoffMin)
    set('daily_budget_cap', patch.dailyBudgetCap)

    const { error } = await ((supabase.from('book_configs') as any)
      .upsert(row, { onConflict: 'book_id' })) as { error: unknown }
    if (error) return null
    return getBookConfig(patch.bookId)
  } catch {
    return null
  }
}

/** Remove a book config row (reverts the book to registry defaults; config-only books disappear). */
export async function deleteBookConfig(bookId: string): Promise<boolean> {
  try {
    const supabase = createServerClient()
    const { error } = await (supabase.from('book_configs').delete().eq('book_id', bookId)) as { error: unknown }
    return !error
  } catch {
    return false
  }
}

/** Adapt a BookConfig to the placement queue's contract (lib/placement/config.ts). */
export function toPlacementConfig(c: BookConfig): BookPlacementConfig {
  return {
    enabled:              c.enabled,
    minStake:             Math.max(1, Math.round(c.minStake)),
    dailyBudgetCap:       Math.max(1, Math.round(c.dailyBudgetCap)),
    delayMinSec:          c.delayMinSec,
    delayMaxSec:          c.delayMaxSec,
    kickoffCutoffMinutes: c.kickoffCutoffMin,
  }
}

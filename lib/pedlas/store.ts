// lib/pedlas/store.ts
// Cloud persistence for PEDLAS books (Supabase). Server-only. Degrades gracefully:
// if the pedlas_books table is missing (migration not yet applied) every call returns
// a soft failure rather than throwing, so the builder keeps working offline-of-DB.

import 'server-only'

import { createServerClient } from '../supabase/server'
import type { PedlasBook } from './types'

export interface SavePedlasInput {
  book:      PedlasBook
  meta:      Record<string, unknown>
  dateFrom?: string
  dateTo?:   string
}

/** Lightweight row for the history list (no full book payload). */
export interface PedlasBookSummary {
  id:              string
  objective:       string
  legCount:        number
  budget:          number
  k:               number
  slipCount:       number
  totalStake:      number
  guaranteedFloor: boolean
  pAnyHit:         number
  evMultiple:      number
  dateFrom:        string | null
  dateTo:          string | null
  createdAt:       string
}

export interface PedlasBookFull {
  id:        string
  book:      PedlasBook
  meta:      Record<string, unknown>
  results:   unknown
  createdAt: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Insert a built book. Returns the new id, or null if persistence is unavailable. */
export async function savePedlasBook(input: SavePedlasInput): Promise<string | null> {
  try {
    const supabase = createServerClient()
    const b = input.book
    const row = {
      objective:        b.objective,
      leg_count:        b.legCount,
      budget:           b.budget,
      k:                b.K,
      slip_count:       b.slips.length,
      total_stake:      b.totalStake,
      guaranteed_floor: b.guaranteedFloor,
      p_any_hit:        b.meta.pAnyHit,
      ev_multiple:      b.verdict.evMultiple,
      date_from:        input.dateFrom ?? null,
      date_to:          input.dateTo ?? null,
      book:             b,
      request_meta:     input.meta,
    }
    const { data, error } = await (supabase
      .from('pedlas_books')
      .insert(row as unknown as any)
      .select('id')
      .single()) as { data: { id: string } | null; error: unknown }
    if (error || !data) return null
    return data.id
  } catch {
    return null
  }
}

export async function listPedlasBooks(limit = 30): Promise<PedlasBookSummary[]> {
  try {
    const supabase = createServerClient()
    const { data, error } = await (supabase
      .from('pedlas_books')
      .select('id, objective, leg_count, budget, k, slip_count, total_stake, guaranteed_floor, p_any_hit, ev_multiple, date_from, date_to, created_at')
      .order('created_at', { ascending: false })
      .limit(limit)) as { data: any[] | null; error: unknown }
    if (error || !data) return []
    return data.map(r => ({
      id: r.id, objective: r.objective, legCount: r.leg_count, budget: r.budget, k: r.k,
      slipCount: r.slip_count, totalStake: r.total_stake, guaranteedFloor: r.guaranteed_floor,
      pAnyHit: r.p_any_hit, evMultiple: r.ev_multiple, dateFrom: r.date_from, dateTo: r.date_to,
      createdAt: r.created_at,
    }))
  } catch {
    return []
  }
}

export async function getPedlasBook(id: string): Promise<PedlasBookFull | null> {
  try {
    const supabase = createServerClient()
    const { data, error } = await (supabase
      .from('pedlas_books')
      .select('id, book, request_meta, results, created_at')
      .eq('id', id)
      .maybeSingle()) as { data: any | null; error: unknown }
    if (error || !data) return null
    return { id: data.id, book: data.book as PedlasBook, meta: (data.request_meta ?? {}) as Record<string, unknown>, results: data.results, createdAt: data.created_at }
  } catch {
    return null
  }
}

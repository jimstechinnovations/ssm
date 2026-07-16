// lib/sessions/store.ts
// The Bet-Manager session: one row per build+place run (pedlas_v3.md §3). A session owns its slips
// (rows in pedla_placements linked by session_id). Server-only, soft-fail (returns null/[] if the
// migration isn't applied) so the rest of the app keeps working.

import 'server-only'
import { randomBytes } from 'node:crypto'
import { createServerClient } from '../supabase/server'
import type { PedlasSlip } from '../pedlas/types'
import { slipIdempotencyKey } from '../placement/queue'

/* eslint-disable @typescript-eslint/no-explicit-any */

export type SessionStatus = 'building' | 'placing' | 'done' | 'failed' | 'stopped'

export interface SessionRow {
  id: string
  code: string
  bookIds: string[]
  dateFrom: string
  dateTo: string
  budget: number
  targetWin: number
  minStake: number
  legCount: number | null
  slipCount: number | null
  poolSize: number | null
  coverageDepth: number | null
  status: SessionStatus
  meta: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface CreateSessionInput {
  bookIds: string[]
  dateFrom: string
  dateTo: string
  budget: number
  targetWin: number
  minStake: number
  legCount?: number
  slipCount?: number
  poolSize?: number
  coverageDepth?: number
  meta?: Record<string, unknown>
}

/** Short human session code, e.g. S-7F3K2Q. */
export function newSessionCode(): string {
  const b32 = randomBytes(4).toString('hex').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6)
  return `S-${b32}`
}

function mapSession(r: any): SessionRow {
  return {
    id: r.id, code: r.code, bookIds: r.book_ids ?? [], dateFrom: r.date_from, dateTo: r.date_to,
    budget: Number(r.budget), targetWin: Number(r.target_win), minStake: Number(r.min_stake),
    legCount: r.leg_count, slipCount: r.slip_count, poolSize: r.pool_size, coverageDepth: r.coverage_depth,
    status: r.status, meta: r.meta ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

/** Create a session row. Returns it, or null on failure. */
export async function createSession(input: CreateSessionInput): Promise<SessionRow | null> {
  try {
    const supabase = createServerClient()
    const row = {
      code: newSessionCode(),
      book_ids: input.bookIds,
      date_from: input.dateFrom,
      date_to: input.dateTo,
      budget: input.budget,
      target_win: input.targetWin,
      min_stake: input.minStake,
      leg_count: input.legCount ?? null,
      slip_count: input.slipCount ?? null,
      pool_size: input.poolSize ?? null,
      coverage_depth: input.coverageDepth ?? null,
      status: 'building' as SessionStatus,
      meta: input.meta ?? null,
    }
    const { data, error } = await (supabase.from('pedla_sessions').insert(row as any).select('*').single()) as { data: any; error: unknown }
    if (error || !data) return null
    return mapSession(data)
  } catch { return null }
}

export interface SessionPatch {
  status?: SessionStatus
  legCount?: number
  slipCount?: number
  poolSize?: number
  coverageDepth?: number
  meta?: Record<string, unknown>
}

export async function updateSession(id: string, patch: SessionPatch): Promise<boolean> {
  try {
    const supabase = createServerClient()
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (patch.status !== undefined) row.status = patch.status
    if (patch.legCount !== undefined) row.leg_count = patch.legCount
    if (patch.slipCount !== undefined) row.slip_count = patch.slipCount
    if (patch.poolSize !== undefined) row.pool_size = patch.poolSize
    if (patch.coverageDepth !== undefined) row.coverage_depth = patch.coverageDepth
    if (patch.meta !== undefined) row.meta = patch.meta
    const { error } = await ((supabase.from('pedla_sessions') as any).update(row).eq('id', id)) as { error: unknown }
    return !error
  } catch { return false }
}

export async function getSession(idOrCode: string): Promise<SessionRow | null> {
  try {
    const supabase = createServerClient()
    const col = /^S-/.test(idOrCode) ? 'code' : 'id'
    const { data, error } = await (supabase.from('pedla_sessions').select('*').eq(col, idOrCode).single()) as { data: any; error: unknown }
    if (error || !data) return null
    return mapSession(data)
  } catch { return null }
}

export async function listSessions(limit = 30): Promise<SessionRow[]> {
  try {
    const supabase = createServerClient()
    const { data, error } = await (supabase.from('pedla_sessions').select('*').order('created_at', { ascending: false }).limit(limit)) as { data: any[] | null; error: unknown }
    if (error || !data) return []
    return data.map(mapSession)
  } catch { return [] }
}

/** Persist a session's slips as pending placement rows (booking code added later by the placer). */
export async function saveSessionSlips(sessionId: string, bookId: string, slips: PedlasSlip[]): Promise<number> {
  if (slips.length === 0) return 0
  try {
    const supabase = createServerClient()
    const rows = slips.map(slip => ({
      session_id:      sessionId,
      run_id:          sessionId,               // sessions ARE the run for grouping
      book_id:         bookId,
      slip_id:         slip.slipId,
      idempotency_key: slipIdempotencyKey(bookId, slip),
      dry_run:         true,                     // flips to false when a live placement confirms
      stake:           slip.stake,
      combined_odds:   slip.combinedOdds,
      potential_payout: slip.payout,
      leg_count:       slip.legCount,
      legs:            slip.legs,
      true_prob:       slip.trueProb,
      status:          'pending',
      attempts:        0,
    }))
    const { data, error } = await (supabase.from('pedla_placements').insert(rows as any).select('id')) as { data: any[] | null; error: unknown }
    if (error || !data) return 0
    return data.length
  } catch { return 0 }
}

export interface SessionSlip {
  id: string
  slipId: number
  bookId: string
  status: string
  stake: number
  combinedOdds: number
  potentialPayout: number | null
  legCount: number
  legs: unknown
  bookingCode: string | null
  betId: string | null
  attempts: number
  settled: boolean
  won: boolean | null
  returned: number | null
  failureReason: string | null
}

export async function listSessionSlips(sessionId: string): Promise<SessionSlip[]> {
  try {
    const supabase = createServerClient()
    const { data, error } = await (supabase.from('pedla_placements').select('*').eq('session_id', sessionId).order('slip_id', { ascending: true })) as { data: any[] | null; error: unknown }
    if (error || !data) return []
    return data.map((r: any) => ({
      id: r.id, slipId: r.slip_id, bookId: r.book_id, status: r.status, stake: Number(r.stake),
      combinedOdds: r.combined_odds, potentialPayout: r.potential_payout == null ? null : Number(r.potential_payout),
      legCount: r.leg_count, legs: r.legs ?? [], bookingCode: r.booking_code, betId: r.bet_id,
      attempts: r.attempts ?? 0, settled: Boolean(r.settled), won: r.won,
      returned: r.returned == null ? null : Number(r.returned), failureReason: r.failure_reason,
    }))
  } catch { return [] }
}

/** Roll a session's slips up into a scoreboard for the dashboard / detail view. */
export interface SessionSummary {
  slips: number
  pending: number
  placed: number
  failed: number
  won: number
  lost: number
  staked: number
  returned: number
  net: number
}

export async function sessionSummary(sessionId: string): Promise<SessionSummary> {
  const slips = await listSessionSlips(sessionId)
  const placed = slips.filter(s => s.status === 'placed' || s.status === 'won' || s.status === 'lost')
  const staked = placed.reduce((a, s) => a + s.stake, 0)
  const returned = slips.reduce((a, s) => a + (s.returned ?? 0), 0)
  return {
    slips: slips.length,
    pending: slips.filter(s => s.status === 'pending' || s.status === 'placing').length,
    placed: placed.length,
    failed: slips.filter(s => s.status === 'failed').length,
    won: slips.filter(s => s.won === true).length,
    lost: slips.filter(s => s.won === false).length,
    staked,
    returned,
    net: returned - staked,
  }
}

// lib/sessions/store.ts
// The Bet-Manager session: one row per build+place run (pedlas_v3.md §3). A session owns its slips
// (rows in pedla_placements linked by session_id). Server-only, soft-fail (returns null/[] if the
// migration isn't applied) so the rest of the app keeps working.

import 'server-only'
import { randomBytes, createHash } from 'node:crypto'
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
  dateTo?: string
  legCount?: number
  slipCount?: number
  poolSize?: number
  coverageDepth?: number
  meta?: Record<string, unknown>
}

export async function updateSession(id: string, patch: SessionPatch, opts: { touch?: boolean } = {}): Promise<boolean> {
  try {
    const supabase = createServerClient()
    // updated_at doubles as the placer heartbeat (run alive vs stalled). Non-placer writes (e.g. settle
    // persisting game outcomes) pass touch:false so they don't make an idle session look like it's running.
    const row: Record<string, unknown> = opts.touch === false ? {} : { updated_at: new Date().toISOString() }
    if (patch.status !== undefined) row.status = patch.status
    if (patch.dateTo !== undefined) row.date_to = patch.dateTo
    if (patch.legCount !== undefined) row.leg_count = patch.legCount
    if (patch.slipCount !== undefined) row.slip_count = patch.slipCount
    if (patch.poolSize !== undefined) row.pool_size = patch.poolSize
    if (patch.coverageDepth !== undefined) row.coverage_depth = patch.coverageDepth
    if (patch.meta !== undefined) row.meta = patch.meta
    const { error } = await ((supabase.from('pedla_sessions') as any).update(row).eq('id', id)) as { error: unknown }
    return !error
  } catch { return false }
}

/** Touch updated_at only — a heartbeat so the UI can tell a run is alive vs stalled (crash/close). */
export async function touchSession(id: string): Promise<void> { try { await updateSession(id, {}) } catch { /* ignore */ } }

/** Ask a running placement to stop (checked by the placer between slips). */
export async function requestStop(idOrCode: string): Promise<boolean> {
  const s = await getSession(idOrCode); if (!s) return false
  return updateSession(s.id, { meta: { ...(s.meta ?? {}), stopRequested: true, stopAt: new Date().toISOString() } })
}
/** Clear the stop flag (when a run (re)starts). */
export async function clearStop(sessionId: string, meta?: Record<string, unknown> | null): Promise<void> {
  await updateSession(sessionId, { meta: { ...(meta ?? {}), stopRequested: false, runStartedAt: new Date().toISOString() } })
}
/** Is a stop currently requested for this session? (read by the slip-status report). */
export async function isStopRequested(sessionId: string): Promise<boolean> {
  const s = await getSession(sessionId); return Boolean((s?.meta as any)?.stopRequested)
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

/** Per-session idempotency key: the slip's key namespaced by session, so a CLONED session's identical
 *  slips can be placed independently (horizontal scaling) without colliding on the unique index. */
function sessionSlipKey(sessionId: string, bookId: string, slip: PedlasSlip): string {
  return createHash('sha256').update(`${sessionId}|${slipIdempotencyKey(bookId, slip)}`).digest('hex').slice(0, 24)
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
      idempotency_key: sessionSlipKey(sessionId, bookId, slip),
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

/** Update one session slip's placement status (called by the placer as each slip resolves). */
export async function updateSessionSlipStatus(sessionId: string, slipId: number, patch: {
  status: 'pending' | 'placing' | 'placed' | 'failed' | 'skipped'
  bookingCode?: string | null
  betId?: string | null
  failureReason?: string | null
  live?: boolean
}): Promise<boolean> {
  try {
    const supabase = createServerClient()
    const row: Record<string, unknown> = { status: patch.status, updated_at: new Date().toISOString() }
    if (patch.bookingCode !== undefined) row.booking_code = patch.bookingCode
    if (patch.betId !== undefined) row.bet_id = patch.betId
    if (patch.failureReason !== undefined) row.failure_reason = patch.failureReason
    if (patch.status === 'placed') { row.dry_run = !patch.live ? true : false; row.confirmed_by = 'balance+history'; row.placed_at = new Date().toISOString(); row.failure_reason = null } // clear any prior failure on successful retry
    const { error } = await ((supabase.from('pedla_placements') as any)
      .update(row).eq('session_id', sessionId).eq('slip_id', slipId)) as { error: unknown }
    return !error
  } catch { return false }
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

/** List a session's slips. `withLegs` pulls the heavy 34-leg JSON (only clone needs it); `limit`
 *  caps rows for the UI table. Excluding legs keeps the dashboard/detail fast on 500-slip sessions. */
export async function listSessionSlips(sessionId: string, opts: { withLegs?: boolean; limit?: number; offset?: number } = {}): Promise<SessionSlip[]> {
  try {
    const supabase = createServerClient()
    const cols = 'id,slip_id,book_id,status,stake,combined_odds,potential_payout,leg_count,booking_code,bet_id,attempts,settled,won,returned,failure_reason'
      + (opts.withLegs ? ',legs' : '')
    let q = supabase.from('pedla_placements').select(cols).eq('session_id', sessionId).order('slip_id', { ascending: true })
    if (opts.offset != null && opts.limit) q = q.range(opts.offset, opts.offset + opts.limit - 1)
    else if (opts.limit) q = q.limit(opts.limit)
    const { data, error } = await (q as any) as { data: any[] | null; error: unknown }
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

/** One slip WITH legs (for the click-to-view overlay) — a single-row query, not the whole book. */
export async function getSessionSlip(sessionId: string, slipId: number): Promise<SessionSlip | null> {
  try {
    const supabase = createServerClient()
    const { data, error } = await (supabase.from('pedla_placements')
      .select('id,slip_id,book_id,status,stake,combined_odds,potential_payout,leg_count,booking_code,bet_id,attempts,settled,won,returned,failure_reason,legs')
      .eq('session_id', sessionId).eq('slip_id', slipId).limit(1).single()) as { data: any; error: unknown }
    if (error || !data) return null
    return {
      id: data.id, slipId: data.slip_id, bookId: data.book_id, status: data.status, stake: Number(data.stake),
      combinedOdds: data.combined_odds, potentialPayout: data.potential_payout == null ? null : Number(data.potential_payout),
      legCount: data.leg_count, legs: data.legs ?? [], bookingCode: data.booking_code, betId: data.bet_id,
      attempts: data.attempts ?? 0, settled: Boolean(data.settled), won: data.won,
      returned: data.returned == null ? null : Number(data.returned), failureReason: data.failure_reason,
    }
  } catch { return null }
}

/** Placed (real) slips WITH legs, for settlement. status in placed/won/lost. */
export async function listPlacedSlipsWithLegs(sessionId: string): Promise<SessionSlip[]> {
  try {
    const supabase = createServerClient()
    const { data, error } = await (supabase.from('pedla_placements')
      .select('id,slip_id,book_id,status,stake,combined_odds,potential_payout,leg_count,booking_code,bet_id,attempts,settled,won,returned,failure_reason,legs')
      .eq('session_id', sessionId).in('status', ['placed', 'won', 'lost'])) as { data: any[] | null; error: unknown }
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

/** Rewrite potential_payout for a batch of slips (e.g. after a max-win cap fix). Chunked. */
export async function updateSlipPayouts(sessionId: string, updates: { slipId: number; payout: number }[]): Promise<number> {
  if (!updates.length) return 0
  try {
    const supabase = createServerClient()
    let n = 0
    const CHUNK = 25
    for (let i = 0; i < updates.length; i += CHUNK) {
      const res = await Promise.all(updates.slice(i, i + CHUNK).map(u =>
        ((supabase.from('pedla_placements') as any)
          .update({ potential_payout: u.payout, updated_at: new Date().toISOString() })
          .eq('session_id', sessionId).eq('slip_id', u.slipId)) as Promise<{ error: unknown }>))
      n += res.filter(r => !r.error).length
    }
    return n
  } catch { return 0 }
}

/** Record a slip's settlement (won/lost) — status, settled flag, returned amount. */
export async function settleSessionSlip(sessionId: string, slipId: number, won: boolean, returned: number, note?: string): Promise<boolean> {
  try {
    const supabase = createServerClient()
    const row: Record<string, unknown> = { status: won ? 'won' : 'lost', settled: true, settled_at: new Date().toISOString(), settled_by: 'auto', won, returned, updated_at: new Date().toISOString() }
    if (note) row.notes = note
    const { error } = await ((supabase.from('pedla_placements') as any).update(row).eq('session_id', sessionId).eq('slip_id', slipId)) as { error: unknown }
    return !error
  } catch { return false }
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

/**
 * Clone a session (same games/slips/params) into a NEW session id, so the identical book can be
 * placed independently — e.g. in parallel on another account — for horizontal scaling. Slips get
 * fresh per-session idempotency keys, so both sessions place without colliding.
 */
export async function cloneSession(sourceIdOrCode: string): Promise<SessionRow | null> {
  const src = await getSession(sourceIdOrCode)
  if (!src) return null
  const slips = await listSessionSlips(src.id, { withLegs: true })

  const clone = await createSession({
    bookIds: src.bookIds, dateFrom: src.dateFrom, dateTo: src.dateTo,
    budget: src.budget, targetWin: src.targetWin, minStake: src.minStake,
    legCount: src.legCount ?? undefined, slipCount: src.slipCount ?? undefined,
    poolSize: src.poolSize ?? undefined, coverageDepth: src.coverageDepth ?? undefined,
    meta: { ...(src.meta ?? {}), clonedFrom: src.code },
  })
  if (!clone) return null

  const byBook = new Map<string, PedlasSlip[]>()
  for (const s of slips) {
    const ps = {
      slipId: s.slipId, legs: s.legs, stake: s.stake, combinedOdds: s.combinedOdds,
      legCount: s.legCount, payout: s.potentialPayout ?? 0, trueProb: 0, vector: [],
      boostPct: 0, uncappedPayout: s.potentialPayout ?? 0, capped: false, evMultiple: 0, rankScore: 0,
    } as unknown as PedlasSlip
    const arr = byBook.get(s.bookId) ?? []; arr.push(ps); byBook.set(s.bookId, arr)
  }
  let total = 0
  for (const [bookId, ps] of byBook) total += await saveSessionSlips(clone.id, bookId, ps)
  await updateSession(clone.id, { status: total > 0 ? 'placing' : 'failed', slipCount: total })
  return getSession(clone.id)
}

const emptySummary = (): SessionSummary => ({ slips: 0, pending: 0, placed: 0, failed: 0, won: 0, lost: 0, staked: 0, returned: 0, net: 0 })

/** Scoreboards for many sessions in ONE tiny query: only NON-pending rows (most slips are pending),
 *  deriving `pending` from each session's slip count. Fast even for many 500-slip sessions. */
export async function scoreboards(sessions: { id: string; slipCount: number | null }[]): Promise<Record<string, SessionSummary>> {
  const out: Record<string, SessionSummary> = {}
  for (const s of sessions) out[s.id] = { ...emptySummary(), slips: s.slipCount ?? 0 }
  if (sessions.length === 0) return out
  try {
    const supabase = createServerClient()
    const { data } = await (supabase.from('pedla_placements')
      .select('session_id,status,stake,returned,won')
      .in('session_id', sessions.map(s => s.id))
      .neq('status', 'pending')) as { data: any[] | null }
    for (const r of data ?? []) {
      const s = out[r.session_id]; if (!s) continue
      const placed = r.status === 'placed' || r.status === 'won' || r.status === 'lost'
      if (r.status === 'placing') s.pending++
      if (placed) { s.placed++; s.staked += Number(r.stake) }
      if (r.status === 'failed') s.failed++
      if (r.won === true) s.won++
      if (r.won === false) s.lost++
      s.returned += Number(r.returned ?? 0)
    }
    for (const s of sessions) {
      const sum = out[s.id]
      sum.pending = Math.max(0, (s.slipCount ?? 0) - sum.placed - sum.failed) // rest are pending
      sum.net = sum.returned - sum.staked
    }
  } catch { /* soft-fail → zeros */ }
  return out
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

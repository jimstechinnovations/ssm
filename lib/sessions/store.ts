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
  /** Server-computed timings, so the UI never reads the clock during render (and clock skew can't
   *  mis-flag a run): ms since the last placer heartbeat / since creation, and whether the game window ended. */
  heartbeatAgeMs: number
  ageMs: number
  expired: boolean
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
    heartbeatAgeMs: Date.now() - Date.parse(r.updated_at), ageMs: Date.now() - Date.parse(r.created_at),
    expired: Date.parse(`${r.date_to}T23:59:59Z`) < Date.now(),
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
      decision:        (slip as PedlasSlip & { decision?: unknown }).decision ?? null,
      status:          'pending',
      attempts:        0,
    }))
    const { data, error } = await (supabase.from('pedla_placements').insert(rows as any).select('id')) as { data: any[] | null; error: unknown }
    if (error || !data) return 0
    return data.length
  } catch { return 0 }
}

/** Update one session slip's placement status (called by the placer as each slip resolves).
 *
 *  With `worker` (queue mode) the update only applies if that worker still HOLDS the slip (claimed_by +
 *  status placing/submitting) — a worker that lost its lease can never overwrite another PC's result.
 *  status 'retry' = a transient failure: the slip goes back to the shared queue (any PC may retry it)
 *  until its attempts are used up, then it becomes 'failed'. Returns false if nothing was updated. */
export async function updateSessionSlipStatus(sessionId: string, slipId: number, patch: {
  status: 'pending' | 'placing' | 'placed' | 'failed' | 'skipped' | 'retry' | 'verify'
  worker?: string
  bookingCode?: string | null
  betId?: string | null
  failureReason?: string | null
  live?: boolean
  droppedFixtures?: number[]
  placedLegs?: number
  /** The SITE's own numbers read off the betslip right before Confirm (what was really staked). */
  siteOdds?: number | null
  siteStake?: number | null
  sitePayout?: number | null
  placedFixtures?: number[] | null
}, maxAttempts = 3): Promise<boolean> {
  try {
    const supabase = createServerClient()
    const { data: cur } = await (supabase.from('pedla_placements')
      .select('legs,attempts').eq('session_id', sessionId).eq('slip_id', slipId).single()) as { data: { legs: unknown; attempts: number } | null }
    if (!cur) return false
    const now = new Date().toISOString()
    const status = patch.status === 'retry' ? ((cur.attempts ?? 0) >= maxAttempts ? 'failed' : 'pending') : patch.status
    const row: Record<string, unknown> = { status, updated_at: now }
    if (patch.siteOdds != null) row.site_odds = patch.siteOdds
    if (patch.siteStake != null) row.site_stake = patch.siteStake
    if (patch.sitePayout != null) row.site_payout = patch.sitePayout
    if (patch.placedFixtures?.length) row.placed_fixtures = patch.placedFixtures
    if (patch.bookingCode !== undefined) row.booking_code = patch.bookingCode
    if (patch.betId !== undefined) row.bet_id = patch.betId
    if (patch.failureReason !== undefined) { row.failure_reason = patch.failureReason; row.last_error = patch.failureReason }
    if (status === 'pending') { row.claimed_by = null; row.claim_expires_at = null }        // back to the shared queue
    if (status === 'failed' || status === 'skipped' || status === 'verify') row.claim_expires_at = null
    if (status === 'placed') { row.dry_run = !patch.live; row.confirmed_by = 'site'; row.placed_at = now; row.failure_reason = null; row.claim_expires_at = null } // clear any prior failure on successful retry
    // Match the DB to what was ACTUALLY placed: if the placer dropped legs (games suspended at placement),
    // mark those legs suspended in the stored slip and record the real leg count, so settle/survival/payout
    // all reflect the shorter combo that was truly staked — not the built record.
    if (status === 'placed' && patch.droppedFixtures?.length) {
      const legs = (cur.legs as Array<{ fixtureId: number; suspended?: boolean }> | undefined) ?? []
      if (legs.length) {
        const drop = new Set(patch.droppedFixtures)
        row.legs = legs.map(l => drop.has(l.fixtureId) ? { ...l, suspended: true } : l)
      }
      if (patch.placedLegs != null) row.leg_count = patch.placedLegs
    }
    let q = (supabase.from('pedla_placements') as any).update(row).eq('session_id', sessionId).eq('slip_id', slipId)
    if (patch.worker) q = q.eq('claimed_by', patch.worker).in('status', ['placing', 'submitting'])
    const { data, error } = await q.select('id') as { data: unknown[] | null; error: unknown }
    return !error && (data?.length ?? 0) > 0
  } catch { return false }
}

/** Resolve a slip stuck in 'verify' (its worker vanished mid-submit): placed = it IS on the bet history
 *  (record it), not placed = it is NOT there (return it to the queue). */
export async function resolveVerify(sessionId: string, slipId: number, placed: boolean, info: { bookingCode?: string | null; betId?: string | null; note?: string } = {}): Promise<boolean> {
  try {
    const supabase = createServerClient()
    const now = new Date().toISOString()
    const row: Record<string, unknown> = placed
      ? { status: 'placed', dry_run: false, confirmed_by: 'bet-history', placed_at: now, claim_expires_at: null, failure_reason: null, last_error: info.note ?? null, updated_at: now }
      : { status: 'pending', claimed_by: null, claim_expires_at: null, submit_started_at: null, last_error: info.note ?? 'not on bet history — returned to the queue', updated_at: now }
    if (info.bookingCode !== undefined) row.booking_code = info.bookingCode
    if (info.betId !== undefined) row.bet_id = info.betId
    const { data, error } = await ((supabase.from('pedla_placements') as any).update(row)
      .eq('session_id', sessionId).eq('slip_id', slipId).eq('status', 'verify').select('id')) as { data: unknown[] | null; error: unknown }
    return !error && (data?.length ?? 0) > 0
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
  /** What the SITE accepted at Confirm (null when not captured — older runs, or 007 not applied). */
  siteOdds: number | null
  siteStake: number | null
  sitePayout: number | null
  /** Decision Bot: the slip-level decision (rule, reason, win chance, keep); null for other engines. */
  decision: Record<string, unknown> | null
  lastError: string | null
}

/** What this slip really pays if it wins: the site's own Potential Win when captured, else the built
 *  payout. Settlement and every UI total use this, so the app matches the bookmaker. */
export function effectivePayout(s: Pick<SessionSlip, 'sitePayout' | 'potentialPayout'>): number {
  return s.sitePayout ?? s.potentialPayout ?? 0
}

const BASE_COLS = 'id,slip_id,book_id,status,stake,combined_odds,potential_payout,leg_count,booking_code,bet_id,attempts,settled,won,returned,failure_reason,site_odds'
const RECEIPT_COLS = ',site_stake,site_payout,decision,last_error'   // 007/008 — dropped automatically if a migration isn't applied

function mapSlip(r: any): SessionSlip {
  const num = (v: unknown) => v == null ? null : Number(v)
  return {
    id: r.id, slipId: r.slip_id, bookId: r.book_id, status: r.status, stake: Number(r.stake),
    combinedOdds: r.combined_odds, potentialPayout: num(r.potential_payout),
    legCount: r.leg_count, legs: r.legs ?? [], bookingCode: r.booking_code, betId: r.bet_id,
    attempts: r.attempts ?? 0, settled: Boolean(r.settled), won: r.won,
    returned: num(r.returned), failureReason: r.failure_reason,
    siteOdds: num(r.site_odds), siteStake: num(r.site_stake), sitePayout: num(r.site_payout),
    decision: r.decision ?? null, lastError: r.last_error ?? null,
  }
}

/** Run a slip select with the 007 receipt columns; if they don't exist yet, rerun without them. */
async function selectSlips(build: (cols: string) => any, extra = ''): Promise<any[] | null> {
  let { data, error } = await build(BASE_COLS + RECEIPT_COLS + extra) as { data: any[] | null; error: { message?: string } | null }
  if (error && /column|schema cache/i.test(error.message ?? '')) ({ data, error } = await build(BASE_COLS + extra))
  return error ? null : (data ?? [])
}

/** Which DB column each UI sort key maps to (whitelist — never interpolate user input into a query). */
const SORT_COLS: Record<string, string> = {
  slipId: 'slip_id', legs: 'leg_count', odds: 'combined_odds', payout: 'potential_payout', status: 'status',
}

export interface ListSlipsOpts {
  withLegs?: boolean; limit?: number; offset?: number
  status?: string            // filter to one status (placed/won/lost/pending/failed/skipped); 'all' = no filter
  search?: string            // match a booking code (prefix) or an exact slip number
  sortBy?: string            // one of SORT_COLS keys
  sortDir?: 'asc' | 'desc'
}

/** Apply the shared status/search filters to a pedla_placements query builder. */
function applySlipFilters(q: any, opts: ListSlipsOpts) {
  if (opts.status && opts.status !== 'all') {
    if (opts.status === 'pending') q = q.in('status', ['pending', 'placing'])
    else q = q.eq('status', opts.status)
  }
  const s = opts.search?.trim()
  if (s) {
    if (/^\d+$/.test(s)) q = q.or(`slip_id.eq.${Number(s)},booking_code.ilike.${s}%`)
    else q = q.ilike('booking_code', `${s}%`)
  }
  return q
}

/** List a session's slips. `withLegs` pulls the heavy 34-leg JSON (only clone needs it); `limit`
 *  caps rows for the UI table. Excluding legs keeps the dashboard/detail fast on 500-slip sessions.
 *  Supports server-side status filter, booking-code/slip# search, and column sort (so "all placed
 *  together" and search work across the whole book, not just the visible page). */
export async function listSessionSlips(sessionId: string, opts: ListSlipsOpts = {}): Promise<SessionSlip[]> {
  try {
    const supabase = createServerClient()
    const sortCol = (opts.sortBy && SORT_COLS[opts.sortBy]) || 'slip_id'
    const asc = opts.sortDir ? opts.sortDir === 'asc' : true
    // The API returns at most 1,000 rows per request, so read in 1,000-row pages until `limit` (or the
    // whole session when no limit) — a 2,000-slip session must never be silently cut to 1,000.
    const start = opts.offset ?? 0
    const want = opts.limit ?? Infinity
    const out: SessionSlip[] = []
    for (let from = start; out.length < want; from += 1000) {
      const n = Math.min(1000, want - out.length)
      const data = await selectSlips(cols => applySlipFilters(supabase.from('pedla_placements').select(cols).eq('session_id', sessionId), opts)
        .order(sortCol, { ascending: asc }).order('slip_id', { ascending: true })   // stable tiebreak
        .range(from, from + n - 1), opts.withLegs ? ',legs' : '')
      if (!data) break
      out.push(...data.map(mapSlip))
      if (data.length < n) break
    }
    return out
  } catch { return [] }
}

/** Count a session's slips under the same status/search filters (for filtered pagination). */
export async function countSessionSlips(sessionId: string, opts: ListSlipsOpts = {}): Promise<number> {
  try {
    const supabase = createServerClient()
    let q = supabase.from('pedla_placements').select('slip_id', { count: 'exact', head: true }).eq('session_id', sessionId)
    q = applySlipFilters(q, opts)
    const { count, error } = await (q as any) as { count: number | null; error: unknown }
    return error ? 0 : (count ?? 0)
  } catch { return 0 }
}

/** One slip WITH legs (for the click-to-view overlay) — a single-row query, not the whole book. */
export async function getSessionSlip(sessionId: string, slipId: number): Promise<SessionSlip | null> {
  try {
    const supabase = createServerClient()
    const data = await selectSlips(cols => supabase.from('pedla_placements').select(cols)
      .eq('session_id', sessionId).eq('slip_id', slipId).limit(1), ',legs')
    return data?.[0] ? mapSlip(data[0]) : null
  } catch { return null }
}

/** Placed (real) slips WITH legs, for settlement. status in placed/won/lost. */
export async function listPlacedSlipsWithLegs(sessionId: string): Promise<SessionSlip[]> {
  try {
    const supabase = createServerClient()
    const data = await selectSlips(cols => supabase.from('pedla_placements').select(cols)
      .eq('session_id', sessionId).in('status', ['placed', 'won', 'lost']), ',legs')
    return (data ?? []).map(mapSlip)
  } catch { return [] }
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

/**
 * Return 'skipped' and/or 'failed' slips to the pending queue so they get another live attempt — e.g.
 * "skipped" because the site's odds had drifted below target at the time (safe: nothing was staked), or
 * "failed" after exhausting retries. Resets attempts to 0 and clears every claim/lease field, so a slip
 * that hit the 3-attempt cap gets a fresh budget rather than being claimed and instantly re-failed.
 * Never touches 'placed'/'won'/'lost'/'verify' slips. Returns how many rows were reset.
 */
export async function requeueSession(sessionId: string, statuses: ('skipped' | 'failed')[] = ['skipped', 'failed']): Promise<number> {
  try {
    const supabase = createServerClient()
    // Count BEFORE the update, not via .update().select() — that combination returned an empty/null `data`
    // here despite the update itself succeeding (an RLS representation-return quirk, 2026-09-26), which
    // silently under-reported a real requeue as 0. A plain count avoids relying on the update's own return.
    const { count } = await (supabase.from('pedla_placements') as any)
      .select('id', { count: 'exact', head: true }).eq('session_id', sessionId).in('status', statuses)
    const row = { status: 'pending', claimed_by: null, claim_expires_at: null, submit_started_at: null, attempts: 0, last_error: null, updated_at: new Date().toISOString() }
    const { error } = await ((supabase.from('pedla_placements') as any).update(row).eq('session_id', sessionId).in('status', statuses)) as { error: unknown }
    return error ? 0 : (count ?? 0)
  } catch { return 0 }
}

/** Roll a session's slips up into a scoreboard for the dashboard / detail view. */
export interface SessionSummary {
  slips: number
  pending: number
  placed: number
  failed: number
  skipped: number   // not placed on purpose (suspended / odds too unstable)
  verify: number    // a worker vanished mid-submit — must be checked against bet history (never auto-retried)
  inFlight: number  // claimed by a worker right now (placing / submitting)
  won: number
  lost: number
  open: number      // placed but not yet settled
  staked: number    // everything actually staked (site stake when captured)
  settledStaked: number
  returned: number
  net: number       // returned − settledStaked (settled slips only)
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
      boostPct: 0, uncappedPayout: s.potentialPayout ?? 0, capped: false, evMultiple: 0, rankScore: 0, decision: s.decision,
    } as unknown as PedlasSlip
    const arr = byBook.get(s.bookId) ?? []; arr.push(ps); byBook.set(s.bookId, arr)
  }
  let total = 0
  for (const [bookId, ps] of byBook) total += await saveSessionSlips(clone.id, bookId, ps)
  await updateSession(clone.id, { status: total > 0 ? 'placing' : 'failed', slipCount: total })
  return getSession(clone.id)
}

const emptySummary = (): SessionSummary => ({ slips: 0, pending: 0, placed: 0, failed: 0, skipped: 0, verify: 0, inFlight: 0, won: 0, lost: 0, open: 0, staked: 0, settledStaked: 0, returned: 0, net: 0 })

/** Scoreboards for many sessions in ONE tiny query: only NON-pending rows (most slips are pending),
 *  deriving `pending` from each session's slip count. Fast even for many 500-slip sessions.
 *  Money uses what the SITE took (site_stake) when captured, and `net` counts SETTLED slips only —
 *  an unsettled stake is not a loss yet, so a live session never shows a fake deficit. */
export async function scoreboards(sessions: { id: string; slipCount: number | null }[]): Promise<Record<string, SessionSummary>> {
  const out: Record<string, SessionSummary> = {}
  for (const s of sessions) out[s.id] = { ...emptySummary(), slips: s.slipCount ?? 0 }
  if (sessions.length === 0) return out
  try {
    const supabase = createServerClient()
    // PAGE through every row: the API caps a response at 1,000 rows, and a few 500-slip sessions exceed
    // that — an unpaged read silently dropped rows and showed placed slips as pending (0 placed).
    const page = (cols: string, from: number) => (supabase.from('pedla_placements').select(cols)
      .in('session_id', sessions.map(s => s.id)).neq('status', 'pending')
      .order('id', { ascending: true }).range(from, from + 999)) as any
    let cols = 'session_id,status,stake,returned,won,settled,site_stake'
    const data: any[] = []
    for (let from = 0; from < 200_000; from += 1000) {
      let res = await page(cols, from) as { data: any[] | null; error: { message?: string } | null }
      if (res.error && from === 0 && /column|schema cache/i.test(res.error.message ?? '')) { cols = 'session_id,status,stake,returned,won,settled'; res = await page(cols, from) }
      if (res.error || !res.data) throw new Error(res.error?.message ?? 'scoreboard read failed')
      data.push(...res.data)
      if (res.data.length < 1000) break
    }
    for (const r of data) {
      const s = out[r.session_id]; if (!s) continue
      const placed = r.status === 'placed' || r.status === 'won' || r.status === 'lost'
      const stake = Number(r.site_stake ?? r.stake)
      if (placed) {
        s.placed++; s.staked += stake
        if (r.settled) { s.settledStaked += stake; s.returned += Number(r.returned ?? 0) } else s.open++
      }
      if (r.status === 'failed') s.failed++
      if (r.status === 'skipped') s.skipped++
      if (r.status === 'verify') s.verify++
      if (r.status === 'placing' || r.status === 'submitting') s.inFlight++
      if (r.won === true) s.won++
      if (r.won === false) s.lost++
    }
    for (const s of sessions) {
      const sum = out[s.id]
      sum.pending = Math.max(0, (s.slipCount ?? 0) - sum.placed - sum.failed - sum.skipped - sum.verify) // not yet placed (incl. in-flight)
      sum.net = sum.returned - sum.settledStaked
    }
  } catch { /* soft-fail → zeros */ }
  return out
}

export async function sessionSummary(sessionId: string): Promise<SessionSummary> {
  const slipCount = await countSessionSlips(sessionId)
  return (await scoreboards([{ id: sessionId, slipCount }]))[sessionId]
}

export interface PlacementWorker { workerId: string; host: string | null; account: string | null; live: boolean; state: string; currentSlip: number | null; placed: number; failed: number; startedAt: string; lastSeenAgoMs: number }

/** PCs/tabs that worked this session in the last 10 minutes (the placer heartbeats every ~10s). */
export async function listWorkers(sessionId: string): Promise<PlacementWorker[]> {
  try {
    const since = new Date(Date.now() - 10 * 60_000).toISOString()
    const { data } = await ((createServerClient() as any).from('placement_workers').select('*')
      .eq('session_id', sessionId).gte('last_seen', since).order('started_at')) as { data: any[] | null }
    return (data ?? []).map(r => ({
      workerId: r.worker_id, host: r.host, account: r.account, live: Boolean(r.live), state: r.state,
      currentSlip: r.current_slip, placed: r.placed ?? 0, failed: r.failed ?? 0, startedAt: r.started_at,
      lastSeenAgoMs: Date.now() - Date.parse(r.last_seen),
    }))
  } catch { return [] }
}

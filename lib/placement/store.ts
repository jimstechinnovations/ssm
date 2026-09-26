// lib/placement/store.ts
// The money ledger: every slip we tried to place, what the BOOKMAKER confirmed, and how it
// eventually settled. Server-only. Degrades gracefully if migration 005 isn't applied yet
// (returns null / [] rather than throwing) so the bot still runs.

import 'server-only'

import { createServerClient } from '../supabase/server'
import type { PedlasLeg, PedlasSlip } from '../pedlas/types'
import type { PlacementJob } from './queue'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PlacementRecord {
  id: string
  runId: string
  bookId: string
  pedlasBookId: string | null
  slipId: number
  dryRun: boolean
  stake: number
  combinedOdds: number
  potentialPayout: number | null
  legCount: number
  legs: (PedlasLeg & { suspended?: boolean })[]
  trueProb: number | null
  /** won/lost = placed AND settled (same statuses the session settler writes). */
  status: 'placed' | 'won' | 'lost' | 'failed' | 'simulated' | 'skipped' | 'pending' | 'placing'
  confirmedBy: string | null
  bookingCode: string | null
  betId: string | null
  siteOdds: number | null
  siteStake: number | null      // what the SITE took (007) — null for older rows
  sitePayout: number | null     // the SITE's Potential Win at Confirm (007)
  sessionId: string | null
  balanceBefore: number | null
  balanceAfter: number | null
  failureReason: string | null
  settled: boolean
  settledAt: string | null
  settledBy: string | null
  won: boolean | null
  returned: number | null
  legResults: unknown
  notes: string | null
  placedAt: string
  createdAt: string
}

export interface SavePlacementInput {
  runId: string
  bookId: string
  pedlasBookId?: string | null
  dryRun: boolean
  job: PlacementJob
  slip: PedlasSlip
}

/** Record one finished job (placed / failed / simulated / skipped). Returns the row id or null. */
export async function savePlacement(input: SavePlacementInput): Promise<string | null> {
  const { job, slip } = input
  const status = job.status === 'placed' ? 'placed'
    : job.status === 'simulated' ? 'simulated'
    : job.status === 'skipped' ? 'skipped'
    : 'failed'
  try {
    const supabase = createServerClient()
    const row = {
      run_id:           input.runId,
      book_id:          input.bookId,
      pedlas_book_id:   input.pedlasBookId ?? null,
      slip_id:          slip.slipId,
      idempotency_key:  job.idempotencyKey,
      dry_run:          input.dryRun,
      stake:            slip.stake,
      combined_odds:    slip.combinedOdds,
      potential_payout: slip.payout,
      leg_count:        slip.legCount,
      legs:             slip.legs,
      true_prob:        slip.trueProb,
      status,
      confirmed_by:     job.receipt?.confirmedBy ?? null,
      booking_code:     job.receipt?.bookingCode ?? null,
      bet_id:           job.receipt?.betId ?? null,
      site_odds:        job.receipt?.siteOdds ?? null,
      balance_before:   job.receipt?.balanceBefore ?? null,
      balance_after:    job.receipt?.balanceAfter ?? null,
      failure_reason:   status === 'placed' ? null : (job.note ?? null),
    }
    const { data, error } = await (supabase
      .from('pedla_placements')
      .insert(row as unknown as any)
      .select('id')
      .single()) as { data: { id: string } | null; error: unknown }
    if (error || !data) return null
    return data.id
  } catch {
    return null
  }
}

function mapRow(r: any): PlacementRecord {
  return {
    id: r.id, runId: r.run_id, bookId: r.book_id, pedlasBookId: r.pedlas_book_id,
    slipId: r.slip_id, dryRun: r.dry_run, stake: Number(r.stake),
    combinedOdds: r.combined_odds, potentialPayout: r.potential_payout == null ? null : Number(r.potential_payout),
    legCount: r.leg_count, legs: r.legs ?? [], trueProb: r.true_prob,
    status: r.status, confirmedBy: r.confirmed_by, bookingCode: r.booking_code, betId: r.bet_id,
    siteOdds: r.site_odds,
    siteStake: r.site_stake == null ? null : Number(r.site_stake),
    sitePayout: r.site_payout == null ? null : Number(r.site_payout),
    sessionId: r.session_id ?? null,
    balanceBefore: r.balance_before == null ? null : Number(r.balance_before),
    balanceAfter: r.balance_after == null ? null : Number(r.balance_after),
    failureReason: r.failure_reason,
    settled: r.settled, settledAt: r.settled_at, settledBy: r.settled_by, won: r.won,
    returned: r.returned == null ? null : Number(r.returned),
    legResults: r.leg_results, notes: r.notes,
    placedAt: r.placed_at, createdAt: r.created_at,
  }
}

/** Paged + searchable ledger for the /placements table. Search matches booking code, book, or slip #. */
export async function listPlacementsPage(opts: { limit?: number; offset?: number; includeDryRun?: boolean; search?: string } = {}): Promise<{ rows: PlacementRecord[]; total: number }> {
  try {
    const supabase = createServerClient()
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50)), offset = Math.max(0, opts.offset ?? 0)
    let q = supabase.from('pedla_placements').select('*', { count: 'exact' }).order('created_at', { ascending: false })
    if (!opts.includeDryRun) q = q.eq('dry_run', false)
    const s = (opts.search ?? '').trim().replace(/[%,()]/g, '')
    if (s) {
      const ors = [`booking_code.ilike.%${s}%`, `book_id.ilike.%${s}%`]
      if (/^\d+$/.test(s)) ors.push(`slip_id.eq.${s}`)
      q = q.or(ors.join(','))
    }
    q = q.range(offset, offset + limit - 1)
    const { data, error, count } = await (q as any) as { data: any[] | null; error: unknown; count: number | null }
    if (error || !data) return { rows: [], total: 0 }
    return { rows: data.map(mapRow), total: count ?? data.length }
  } catch {
    return { rows: [], total: 0 }
  }
}

/** One placement row by id (any age — never a scan of the newest N). */
export async function getPlacement(id: string): Promise<PlacementRecord | null> {
  try {
    const supabase = createServerClient()
    const { data, error } = await (supabase.from('pedla_placements').select('*').eq('id', id).limit(1)) as { data: any[] | null; error: unknown }
    return error || !data?.[0] ? null : mapRow(data[0])
  } catch { return null }
}

/** Placed-but-unsettled real slips — the ones the results loop should chase. */
export async function listOpenPlacements(): Promise<PlacementRecord[]> {
  try {
    const supabase = createServerClient()
    const { data, error } = await (supabase
      .from('pedla_placements')
      .select('*')
      .eq('status', 'placed')
      .eq('dry_run', false)
      .eq('settled', false)
      .limit(5000)
      .order('created_at', { ascending: false })) as { data: any[] | null; error: unknown }
    if (error || !data) return []
    return data.map(mapRow)
  } catch {
    return []
  }
}

export interface SettleInput {
  id: string
  won: boolean
  returned?: number
  legResults?: unknown
  settledBy: 'auto' | 'manual'
  notes?: string
}

/** Record how a placed slip actually finished (auto from results, or by hand). */
export async function settlePlacement(input: SettleInput): Promise<boolean> {
  try {
    const supabase = createServerClient()
    const patch = {
      status: input.won ? 'won' : 'lost',
      settled: true,
      settled_at: new Date().toISOString(),
      settled_by: input.settledBy,
      won: input.won,
      returned: input.returned ?? (input.won ? null : 0),
      leg_results: input.legResults ?? null,
      notes: input.notes ?? null,
      updated_at: new Date().toISOString(),
    }
    const { error } = await ((supabase.from('pedla_placements') as any)
      .update(patch)
      .eq('id', input.id)) as { error: unknown }
    return !error
  } catch {
    return false
  }
}

/** Ledger totals across REAL placements — the honest scoreboard. */
export interface LedgerSummary {
  placed: number
  settled: number
  won: number
  lost: number
  staked: number
  returned: number
  net: number
  openStake: number
}

export async function ledgerSummary(): Promise<LedgerSummary> {
  const rows: Pick<PlacementRecord, 'status' | 'stake' | 'siteStake' | 'settled' | 'won' | 'returned'>[] = []
  try {
    const supabase = createServerClient()
    for (let from = 0; from < 50_000; from += 1000) {
      // narrow columns only (never the legs JSON) — the ledger reads every real slip, so this must stay light
      const { data, error } = await ((supabase.from('pedla_placements').select('id,status,stake,site_stake,settled,won,returned')
        .eq('dry_run', false).in('status', ['placed', 'won', 'lost'])
        .order('id', { ascending: true }).range(from, from + 999)) as any) as { data: any[] | null; error: unknown }
      if (error || !data) break
      rows.push(...data.map(r => ({ status: r.status, stake: Number(r.stake), siteStake: r.site_stake == null ? null : Number(r.site_stake), settled: Boolean(r.settled), won: r.won, returned: r.returned == null ? null : Number(r.returned) })))
      if (data.length < 1000) break
    }
  } catch { /* soft-fail → zeros */ }
  const stakeOf = (r: { siteStake: number | null; stake: number }) => r.siteStake ?? r.stake
  const settled = rows.filter(r => r.settled)
  const returned = settled.reduce((s, r) => s + (r.returned ?? 0), 0)
  return {
    placed: rows.length,
    settled: settled.length,
    won: settled.filter(r => r.won).length,
    lost: settled.filter(r => r.won === false).length,
    staked: rows.reduce((s, r) => s + stakeOf(r), 0),
    returned,
    net: returned - settled.reduce((s, r) => s + stakeOf(r), 0),
    openStake: rows.filter(r => !r.settled).reduce((s, r) => s + stakeOf(r), 0),
  }
}

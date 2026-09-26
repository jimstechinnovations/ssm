/**
 * POST /api/sessions/[id]/queue — the multi-PC placement queue (migration 008). Every placer worker, on
 * any PC, talks to the shared database through this route, so a session can be placed from one PC,
 * moved to another mid-run, or placed from several PCs at once — without any slip being placed twice.
 *
 *   { action: 'claim',  worker, n?, leaseSec? }                → { slips: [...] }   (atomic, SKIP LOCKED)
 *   { action: 'renew',  worker, leaseSec?, host?, account?, live?, currentSlip?, placed?, failed?, state? }
 *                                                              → { held, stop }     (heartbeat + lease renewal)
 *   { action: 'begin',  worker, slipId }                       → { ok }             (point of no return — call
 *                                                                                    right before Confirm)
 *   { action: 'release', worker, state? }                      → { released }       (graceful stop / handover)
 *   { action: 'lock' | 'unlock', worker, account, ttlSec? }    → { ok }             (per-account submit lock)
 */

import { z } from 'zod'
import { getSession, touchSession } from '@/lib/sessions/store'
import { createServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const Schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim'), worker: z.string().min(3), n: z.number().int().min(1).max(20).optional(), leaseSec: z.number().int().min(30).max(900).optional() }),
  z.object({
    action: z.literal('renew'), worker: z.string().min(3), leaseSec: z.number().int().min(30).max(900).optional(),
    host: z.string().optional(), account: z.string().optional(), live: z.boolean().optional(), currentSlip: z.number().int().nullish(),
    placed: z.number().int().optional(), failed: z.number().int().optional(), state: z.string().optional(),
  }),
  z.object({ action: z.literal('begin'), worker: z.string().min(3), slipId: z.number().int() }),
  z.object({ action: z.literal('release'), worker: z.string().min(3), state: z.string().optional() }),
  z.object({ action: z.enum(['lock', 'unlock']), worker: z.string().min(3), account: z.string().min(2), ttlSec: z.number().int().min(5).max(120).optional() }),
])

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = Schema.safeParse(body)
  if (!parsed.success) return Response.json({ error: 'Validation failed', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }, { status: 400 })
  const b = parsed.data
  const db = createServerClient() as any
  const rpc = async (fn: string, args: Record<string, unknown>) => { const { data, error } = await db.rpc(fn, args); if (error) throw new Error(`${fn}: ${error.message}`); return data }
  const stop = Boolean((session.meta as { stopRequested?: boolean } | null)?.stopRequested)

  try {
    switch (b.action) {
      case 'claim': {
        if (stop) return Response.json({ slips: [], stop: true })
        const rows = await rpc('claim_slips', { p_session: session.id, p_worker: b.worker, p_n: b.n ?? 1, p_lease_sec: b.leaseSec ?? 180 }) as any[]
        await touchSession(session.id)
        return Response.json({
          stop: false,
          slips: rows.map(r => ({ id: r.id, slipId: r.slip_id, stake: Number(r.stake), combinedOdds: r.combined_odds, legs: r.legs ?? [], attempts: r.attempts })),
        })
      }
      case 'renew': {
        const held = await rpc('renew_claims', { p_worker: b.worker, p_lease_sec: b.leaseSec ?? 180 }) as number
        await db.from('placement_workers').upsert({
          worker_id: b.worker, session_id: session.id, host: b.host ?? null, account: b.account ?? null, live: b.live ?? false,
          state: b.state ?? 'running', current_slip: b.currentSlip ?? null, placed: b.placed ?? 0, failed: b.failed ?? 0,
          last_seen: new Date().toISOString(),
        })
        await touchSession(session.id)
        return Response.json({ held, stop })
      }
      case 'begin': {
        const { data: row } = await db.from('pedla_placements').select('id').eq('session_id', session.id).eq('slip_id', b.slipId).single()
        if (!row) return Response.json({ ok: false, error: 'unknown slip' }, { status: 404 })
        const ok = await rpc('begin_submit', { p_id: row.id, p_worker: b.worker }) as boolean
        return Response.json({ ok })
      }
      case 'release': {
        const released = await rpc('release_claims', { p_worker: b.worker }) as number
        await db.from('placement_workers').update({ state: b.state ?? 'done', last_seen: new Date().toISOString(), current_slip: null }).eq('worker_id', b.worker)
        return Response.json({ released })
      }
      case 'lock': return Response.json({ ok: await rpc('acquire_account_lock', { p_account: b.account, p_holder: b.worker, p_ttl_sec: b.ttlSec ?? 30 }) })
      case 'unlock': { await rpc('release_account_lock', { p_account: b.account, p_holder: b.worker }); return Response.json({ ok: true }) }
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'queue error' }, { status: 500 })
  }
}

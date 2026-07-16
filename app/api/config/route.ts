/**
 * /api/config — per-book configuration, server-side (Supabase book_configs). CRUD, nothing local.
 *   GET                       → { configs: BookConfig[], placementLive }
 *   PUT  { bookId, ...patch }  → upsert one book's config → { saved, config }
 *   DELETE ?bookId=…          → remove a book's row (reverts to registry defaults) → { deleted }
 *
 * Credentials are NEVER here — those stay in env (see BookAdapter.credentialEnv).
 */

import { z } from 'zod'
import { listBookConfigs, upsertBookConfig, deleteBookConfig } from '@/lib/books/config-store'
import { isLivePlacementAllowed } from '@/lib/placement/queue'

export const runtime = 'nodejs'

const PatchSchema = z.object({
  bookId:           z.string().min(1).regex(/^[a-z0-9_]+$/, 'bookId: lowercase letters, digits, underscore'),
  label:            z.string().min(1).max(80).optional(),
  currency:         z.string().min(1).max(8).optional(),
  minStake:         z.number().positive().max(1_000_000).optional(),
  maxPayout:        z.number().positive().optional(),
  enabled:          z.boolean().optional(),
  boost:            z.unknown().optional(),
  delayMinSec:      z.number().int().min(1).max(3_600).optional(),
  delayMaxSec:      z.number().int().min(1).max(7_200).optional(),
  kickoffCutoffMin: z.number().int().min(0).max(1_440).optional(),
  dailyBudgetCap:   z.number().positive().optional(),
}).refine(c => c.delayMinSec == null || c.delayMaxSec == null || c.delayMaxSec >= c.delayMinSec,
  { message: 'delayMaxSec must be ≥ delayMinSec' })

export async function GET(): Promise<Response> {
  return Response.json({ configs: await listBookConfigs(), placementLive: isLivePlacementAllowed() })
}

export async function PUT(request: Request): Promise<Response> {
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'Validation failed', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    )
  }
  const config = await upsertBookConfig(parsed.data)
  if (!config) return Response.json({ error: 'Could not save config (is migration 006 applied?)' }, { status: 500 })
  return Response.json({ saved: true, config })
}

export async function DELETE(request: Request): Promise<Response> {
  const bookId = new URL(request.url).searchParams.get('bookId')
  if (!bookId) return Response.json({ error: 'bookId query param required' }, { status: 400 })
  const ok = await deleteBookConfig(bookId)
  return ok ? Response.json({ deleted: true }) : Response.json({ error: 'Delete failed' }, { status: 500 })
}

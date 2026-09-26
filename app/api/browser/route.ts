/**
 * /api/browser — control the local debug Chrome from the UI.
 *   GET               → { up, loggedIn, balance, mode }  (REAL/SIM)
 *   POST { action:'launch', mode? } → start it if down, wait for :9222
 *   `port` (GET ?port= / POST body) targets another placement window on this PC (9223, …).
 *   GET ?windows=1          → [{ port, up }] for this PC's placement windows
 *   GET ?shot=PORT[&fresh=1] → PNG of that window's REAL/SIM toggle (fresh=1 takes a new one first)
 */

import { z } from 'zod'
import { readFileSync, existsSync } from 'node:fs'
import { launchBrowser, browserStatus, prepareBrowser, cdpUp, placementPorts, autoBrowsers, refreshToggleShot, toggleShotPath } from '@/lib/placement/browser'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams
  if (q.get('windows')) {
    const ports = placementPorts(autoBrowsers(0, 8))
    return Response.json({ windows: await Promise.all(ports.map(async port => ({ port, up: await cdpUp(port) }))) })
  }
  const shot = Number(q.get('shot'))
  if (shot >= 9222 && shot <= 9240) {
    if (q.get('fresh')) await refreshToggleShot(shot)
    const f = toggleShotPath(shot)
    if (!existsSync(f)) return Response.json({ error: 'no screenshot yet — prepare this window first' }, { status: 404 })
    return new Response(new Uint8Array(readFileSync(f)), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } })
  }
  const port = Number(q.get('port')) || undefined
  return Response.json(await browserStatus(port))
}

const PostSchema = z.object({ action: z.enum(['launch', 'prepare']), mode: z.enum(['dedicated', 'default']).optional(), port: z.number().int().min(9222).max(9240).optional() })

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = PostSchema.safeParse(body)
  if (!parsed.success) return Response.json({ error: 'action must be "launch" or "prepare"' }, { status: 400 })

  if (parsed.data.action === 'prepare') {
    const st = await prepareBrowser(parsed.data.port)   // launch → login → REAL → balance
    return Response.json({ status: st, steps: st.steps }, { status: st.up ? 200 : 202 })
  }
  const r = await launchBrowser(parsed.data.mode ?? 'dedicated', parsed.data.port)
  return Response.json({ ...r, status: await browserStatus(parsed.data.port) }, { status: r.up ? 200 : 202 })
}

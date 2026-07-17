/**
 * /api/browser — control the local debug Chrome from the UI.
 *   GET               → { up, loggedIn, balance, mode }  (REAL/SIM)
 *   POST { action:'launch', mode? } → start it if down, wait for :9222
 */

import { z } from 'zod'
import { launchBrowser, browserStatus, prepareBrowser } from '@/lib/placement/browser'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function GET(): Promise<Response> {
  return Response.json(await browserStatus())
}

const PostSchema = z.object({ action: z.enum(['launch', 'prepare']), mode: z.enum(['dedicated', 'default']).optional() })

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = PostSchema.safeParse(body)
  if (!parsed.success) return Response.json({ error: 'action must be "launch" or "prepare"' }, { status: 400 })

  if (parsed.data.action === 'prepare') {
    const st = await prepareBrowser()   // launch → login → REAL → balance
    return Response.json({ status: st, steps: st.steps }, { status: st.up ? 200 : 202 })
  }
  const r = await launchBrowser(parsed.data.mode ?? 'dedicated')
  return Response.json({ ...r, status: await browserStatus() }, { status: r.up ? 200 : 202 })
}

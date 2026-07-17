/**
 * POST /api/sessions/[id]/fetch-history?limit=N — pull the two teams' H2H (and recent form) from
 * Sofascore for the session's games. Runs the sync in a SEPARATE process (scripts/sync-h2h.mjs) —
 * in-process Playwright blocks the Next event loop. Needs the debug Chrome up on :9222.
 */

import { spawn } from 'node:child_process'
import { getSession } from '@/lib/sessions/store'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  const session = await getSession(id)
  if (!session) return Response.json({ error: 'Unknown session' }, { status: 404 })

  const limit = Math.min(20, Math.max(1, Number(new URL(request.url).searchParams.get('limit')) || 8))
  const origin = new URL(request.url).origin

  const result = await new Promise<Record<string, unknown>>((resolve) => {
    let out = ''
    const p = spawn('node', ['scripts/sync-h2h.mjs', session.code, origin, String(limit)], { shell: process.platform === 'win32' })
    p.stdout.on('data', d => { out += d.toString() })
    p.stderr.on('data', () => {})
    const finish = () => {
      const line = out.split('\n').reverse().find(l => l.startsWith('RESULT '))
      try { resolve(line ? JSON.parse(line.slice(7)) : { error: 'sync produced no result' }) } catch { resolve({ error: 'sync parse error' }) }
    }
    p.on('close', finish)
    p.on('error', () => resolve({ error: 'could not start sync' }))
    setTimeout(() => { p.kill(); finish() }, 280_000)
  })

  if ((result as { needBrowser?: boolean }).needBrowser) return Response.json({ error: 'Browser not up — press “Prepare browser” first' }, { status: 409 })
  return Response.json(result)
}

// scripts/test-queue.mjs — integration test of the multi-PC placement queue (migration 008) against the
// real database. Creates a throwaway session with fake slips (NOTHING is placed at any bookmaker), runs
// concurrent claimers, checks every guarantee, and deletes the session again.
//
//   node scripts/test-queue.mjs
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
const URL_ = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const rest = async (path, init = {}) => { const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } }); const t = await r.text(); if (!r.ok) throw new Error(`${r.status} ${path}: ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null }
const rpc = (fn, args) => rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failures++ }

const N = 50
const [session] = await rest('pedla_sessions', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ code: `S-TEST${Date.now() % 100000}`, book_ids: ['sportybet'], date_from: '2026-01-01', date_to: '2026-01-01', budget: N * 10, target_win: 100, min_stake: 10, status: 'placing', meta: { test: true } }) })
try {
  await rest('pedla_placements', { method: 'POST', body: JSON.stringify(Array.from({ length: N }, (_, i) => ({ session_id: session.id, run_id: session.id, book_id: 'sportybet', slip_id: i + 1, idempotency_key: `test-${session.id}-${i}`, dry_run: true, stake: 10, combined_odds: 10, potential_payout: 100, leg_count: 1, legs: [], status: 'pending', attempts: 0 }))) })

  // 1. six workers claim concurrently, 3 at a time, until the pool is empty
  const got = new Map()
  await Promise.all(Array.from({ length: 6 }, (_, w) => (async () => {
    for (;;) {
      const rows = await rpc('claim_slips', { p_session: session.id, p_worker: `w${w}`, p_n: 3, p_lease_sec: 60 })
      if (!rows.length) break
      for (const r of rows) got.set(r.slip_id, [...(got.get(r.slip_id) ?? []), `w${w}`])
    }
  })()))
  const dup = [...got.values()].filter(v => v.length > 1).length
  check(got.size === N && dup === 0, `6 concurrent workers claimed all ${N} slips exactly once (claimed ${got.size}, duplicates ${dup})`)

  // 2. only the lease holder can begin a submit, and only once
  const [row1] = await rest(`pedla_placements?session_id=eq.${session.id}&slip_id=eq.1&select=id,claimed_by`)
  const other = row1.claimed_by === 'w0' ? 'w1' : 'w0'
  check((await rpc('begin_submit', { p_id: row1.id, p_worker: other })) === false, 'a worker that does not hold the lease cannot submit it')
  check((await rpc('begin_submit', { p_id: row1.id, p_worker: row1.claimed_by })) === true, 'the lease holder can begin the submit')
  check((await rpc('begin_submit', { p_id: row1.id, p_worker: row1.claimed_by })) === false, 'a slip cannot be submitted twice')

  // 3. crash simulation: expire every lease → 'placing' returns to the pool, 'submitting' goes to verify
  await rest(`pedla_placements?session_id=eq.${session.id}`, { method: 'PATCH', body: JSON.stringify({ claim_expires_at: new Date(Date.now() - 1000).toISOString() }) })
  const reclaimed = await rpc('claim_slips', { p_session: session.id, p_worker: 'pcB', p_n: 100, p_lease_sec: 60 })
  const [after1] = await rest(`pedla_placements?id=eq.${row1.id}&select=status`)
  check(reclaimed.length === N - 1 && !reclaimed.some(r => r.slip_id === 1), `PC B picked up the ${N - 1} unsubmitted slips after PC A "died" (got ${reclaimed.length}); the mid-submit slip was NOT handed out`)
  check(after1.status === 'verify', `the slip that died mid-submit is in 'verify' (is '${after1.status}')`)

  // 4. graceful stop hands slips back
  const released = await rpc('release_claims', { p_worker: 'pcB' })
  const pend = await rest(`pedla_placements?session_id=eq.${session.id}&status=eq.pending&select=id`)
  check(released === N - 1 && pend.length === N - 1, `release_claims returned ${released} slips to the queue`)

  // 5. renew keeps a lease alive; per-account lock is exclusive and expires
  await rpc('claim_slips', { p_session: session.id, p_worker: 'pcC', p_n: 2, p_lease_sec: 60 })
  check((await rpc('renew_claims', { p_worker: 'pcC', p_lease_sec: 60 })) === 2, 'renew_claims extends the worker\'s 2 leases')
  const acct = `test-${session.id}`
  check((await rpc('acquire_account_lock', { p_account: acct, p_holder: 'A', p_ttl_sec: 2 })) === true, 'PC A takes the account submit lock')
  check((await rpc('acquire_account_lock', { p_account: acct, p_holder: 'B', p_ttl_sec: 2 })) === false, 'PC B cannot take it while A holds it')
  await sleep(2600)
  check((await rpc('acquire_account_lock', { p_account: acct, p_holder: 'B', p_ttl_sec: 2 })) === true, 'the lock expires if A dies, so B can proceed')
  await rpc('release_account_lock', { p_account: acct, p_holder: 'B' })
} finally {
  await rest(`pedla_sessions?id=eq.${session.id}`, { method: 'DELETE' })   // cascades to its fake slips
  console.log(`cleaned up ${session.code}`)
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall queue guarantees hold')
process.exit(failures ? 1 : 0)

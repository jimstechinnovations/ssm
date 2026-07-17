// scripts/backfill-codes.mjs — upsert booking codes from .placed-log.json into pedla_placements for
// any placed slip missing its code (recovery for runs placed before codes were reported reliably).
import { readFileSync, existsSync } from 'node:fs'
for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(l.trim()); if (m) process.env[m[1]] = m[2].trim() }
const ref = (process.env.SUPABASE_URL || '').replace(/^https?:\/\//, '').split('.')[0], pat = process.env.SUPABASE_ACCESS
const sql = async (q) => { const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) }); const t = await r.text(); if (!r.ok) throw new Error(t.slice(0, 300)); return JSON.parse(t) }

if (!existsSync('.placed-log.json')) { console.log('no .placed-log.json'); process.exit(0) }
const log = JSON.parse(readFileSync('.placed-log.json', 'utf8'))

const rows = await sql("select id, stake, book_id, legs from pedla_placements where status='placed' and booking_code is null")
console.log('placed slips missing a code:', rows.length)
let updated = 0
for (const r of rows) {
  const legs = r.legs || []
  const legSig = legs.map(l => `${l.fixtureId}:${l.outcome}`).sort().join('|')
  const key = `${r.book_id}|${Math.round(Number(r.stake))}|${legSig}`
  const code = log[key]?.code
  if (!code) continue
  await sql(`update pedla_placements set booking_code='${code.replace(/'/g, "''")}' where id='${r.id}'`)
  updated++
}
console.log('backfilled booking codes:', updated)

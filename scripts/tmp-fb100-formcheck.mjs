import { readFileSync, writeFileSync } from 'node:fs'
import { fetchHistoryNote, closeHistorySession } from './lib-history.mjs'

const s = JSON.parse(readFileSync('slip-fb100-100x.json', 'utf8'))
const out = []
for (const l of s.legs) {
  const [home, away] = l.game.split(' vs ')
  let note = null
  try { note = await fetchHistoryNote(home, away) } catch {}
  out.push({ game: l.game, home, away, pick: l.outcome, odds: l.odds, kickoff: l.kickoff, form: note })
  await new Promise(r => setTimeout(r, 120))
}
writeFileSync('.fb100-formcheck.json', JSON.stringify(out))
console.log('done', out.length, 'with form data:', out.filter(x => x.form).length)
await closeHistorySession()

// scripts/algorithm-v1-example.mjs — reproduces the worked example in algorithm_v1.md on LIVE SportyBet
// odds (read-only, public feed, nothing placed).
//
//   node scripts/algorithm-v1-example.mjs [stake=10] [target=200] [K=5] [seed=7]
//
// 1. pulls 3 upcoming games with every two-sided market we can price,
// 2. orders them (kickoff, then shortest match name, then A→Z),
// 3. builds each game's scoreline table (Poisson fitted to the book's de-vigged prices),
// 4. enumerates EVERY combination of one selection per game, keeps those whose payout (with bonus)
//    lands in the target band [T, 1.01·T], and
// 5. runs the decision bot (random / flip / greedy) on that band, printing its decision log.

const [STAKE, TARGET, K, SEED] = [10, 200, 5, 7].map((d, i) => Number(process.argv[2 + i] ?? d))
const BAND = 0.01                         // payout must land in [T, T·(1+BAND)]
const MIN_LEG = 1.20                      // SportyBet bonus: every leg ≥ 1.20
const BONUS = { 3: 0.05, 4: 0.09, 5: 0.15, 6: 0.19, 7: 0.23, 8: 0.26, 9: 0.30, 10: 0.34 }
const bonus = n => BONUS[Math.min(10, n)] ?? 0
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' }

// ── 1. games + markets ──────────────────────────────────────────────────────────
const MKTS = '1,10,18,29,26,31,32,19,20'
const j = await (await fetch(`https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=${encodeURIComponent(MKTS)}&pageSize=40&pageNum=1`, { headers: UA })).json()
const events = j.data.tournaments.flatMap(t => t.events.map(e => ({ ...e, league: t.name })))

/** Every two-sided selection pair: [name, predicate(h,a), odds] ↔ its flip. */
function pairsFor(ev) {
  const m = (id, spec) => ev.markets.find(x => String(x.id) === id && (spec == null || x.specifier === spec))
  const o = (mk, desc) => Number(mk?.outcomes?.find(x => x.desc === desc)?.odds) || null
  const out = []
  const add = (a, pa, oa, b, pb, ob) => { if (oa && ob) out.push([{ name: a, pred: pa, odds: oa }, { name: b, pred: pb, odds: ob }]) }
  const x12 = m('1'), dc = m('10')
  add('Home win', (h, a) => h > a, o(x12, 'Home'), 'Draw or Away', (h, a) => h <= a, o(dc, 'Draw or Away'))
  add('Away win', (h, a) => a > h, o(x12, 'Away'), 'Home or Draw', (h, a) => h >= a, o(dc, 'Home or Draw'))
  add('Draw', (h, a) => h === a, o(x12, 'Draw'), 'Home or Away', (h, a) => h !== a, o(dc, 'Home or Away'))
  for (const L of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]) { const mk = m('18', `total=${L}`); add(`Over ${L}`, (h, a) => h + a > L, o(mk, `Over ${L}`), `Under ${L}`, (h, a) => h + a < L, o(mk, `Under ${L}`)) }
  add('Both score: Yes', (h, a) => h > 0 && a > 0, o(m('29'), 'Yes'), 'Both score: No', (h, a) => h === 0 || a === 0, o(m('29'), 'No'))
  add('Total goals Odd', (h, a) => (h + a) % 2 === 1, o(m('26'), 'Odd'), 'Total goals Even', (h, a) => (h + a) % 2 === 0, o(m('26'), 'Even'))
  add('Home clean sheet: Yes', (h, a) => a === 0, o(m('31'), 'Yes'), 'Home clean sheet: No', (h, a) => a > 0, o(m('31'), 'No'))
  add('Away clean sheet: Yes', (h) => h === 0, o(m('32'), 'Yes'), 'Away clean sheet: No', (h) => h > 0, o(m('32'), 'No'))
  for (const L of [0.5, 1.5, 2.5]) {
    const hm = m('19', `total=${L}`), am = m('20', `total=${L}`)
    add(`Home Over ${L}`, (h) => h > L, o(hm, `Over ${L}`), `Home Under ${L}`, (h) => h < L, o(hm, `Under ${L}`))
    add(`Away Over ${L}`, (h, a) => a > L, o(am, `Over ${L}`), `Away Under ${L}`, (h, a) => a < L, o(am, `Under ${L}`))
  }
  return out
}

const pois = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p }
/** Independent-Poisson scoreline table fitted to the book's de-vigged Home / Away / Over 2.5 / BTTS. */
function fitTable(pairs) {
  const dv = name => { const p = pairs.find(([a]) => a.name === name); if (!p) return null; const s = 1 / p[0].odds + 1 / p[1].odds; return (1 / p[0].odds) / s }
  const tgt = [['Home win', dv('Home win')], ['Away win', dv('Away win')], ['Over 2.5', dv('Over 2.5')], ['Both score: Yes', dv('Both score: Yes')]].filter(x => x[1] != null)
  let best = null
  for (let lh = 0.2; lh <= 3.5; lh += 0.02) for (let la = 0.2; la <= 3.5; la += 0.02) {
    const T = []; for (let h = 0; h <= 9; h++) for (let a = 0; a <= 9; a++) T.push([h, a, pois(lh, h) * pois(la, a)])
    const P = pred => T.reduce((s, [h, a, p]) => s + (pred(h, a) ? p : 0), 0)
    const err = tgt.reduce((s, [n, v]) => s + (P(pairs.find(([x]) => x.name === n)[0].pred) - v) ** 2, 0)
    if (!best || err < best.err) best = { err, lh, la, T }
  }
  return best
}

// ── 2. order: kickoff, then shortest match name, then A→Z (deterministic) ────────
const games = events
  .map(e => ({ id: e.eventId, name: `${e.homeTeamName} vs ${e.awayTeamName}`, league: e.league, kickoff: e.estimateStartTime, pairs: pairsFor(e) }))
  .filter(g => g.pairs.length >= 10)
  .slice(0, 12)
  .sort((a, b) => a.kickoff - b.kickoff || a.name.length - b.name.length || a.name.localeCompare(b.name))
  .slice(0, 3)
if (games.length < 3) { console.log('not enough games with full markets right now'); process.exit(0) }

console.log(`# Worked example — live SportyBet odds, ${new Date().toISOString().slice(0, 16)}Z\n`)
console.log('## Order (kickoff → shortest name → A–Z)')
games.forEach((g, i) => console.log(`${i + 1}. ${g.name} — ${g.league} — ${new Date(g.kickoff).toISOString().slice(0, 16)}Z`))

// ── 3. per-game option table + scoreline fit ─────────────────────────────────────
for (const g of games) {
  g.fit = fitTable(g.pairs)
  const P = pred => g.fit.T.reduce((s, [h, a, p]) => s + (pred(h, a) ? p : 0), 0)
  g.options = g.pairs.flatMap(([a, b], pi) => [{ ...a, flip: b.name, pair: pi, margin: 1 / a.odds + 1 / b.odds - 1 }, { ...b, flip: a.name, pair: pi, margin: 1 / a.odds + 1 / b.odds - 1 }])
    .map(o => ({ ...o, p: P(o.pred), eligible: o.odds >= MIN_LEG }))
  console.log(`\n## ${g.name}  (fitted goals: home ${g.fit.lh.toFixed(2)}, away ${g.fit.la.toFixed(2)})`)
  console.log('| selection | odds | flip | margin | P (scoreline table) | keep = P×odds | ≥1.20 |')
  console.log('|---|---:|---|---:|---:|---:|:-:|')
  for (const o of g.options) console.log(`| ${o.name} | ${o.odds.toFixed(2)} | ${o.flip} | ${(100 * o.margin).toFixed(1)}% | ${(100 * o.p).toFixed(1)}% | ${(o.p * o.odds).toFixed(3)} | ${o.eligible ? '✓' : '✗'} |`)
  // scoreline coverage of a few selections
  const cols = ['Under 4.5', 'Over 1.5', 'Both score: Yes', 'Total goals Even', 'Home win']
  console.log(`\nScoreline table (top 10 by probability) — which selections each score satisfies:`)
  console.log(`| score | P | ${cols.join(' | ')} |`); console.log(`|---|---:|${cols.map(() => ':-:').join('|')}|`)
  for (const [h, a, p] of [...g.fit.T].sort((x, y) => y[2] - x[2]).slice(0, 10)) console.log(`| ${h}-${a} | ${(100 * p).toFixed(1)}% | ${cols.map(c => g.options.find(o => o.name === c)?.pred(h, a) ? '✓' : '·').join(' | ')} |`)
}

// ── 4. enumerate every combination (one selection per game) and band it ──────────
const elig = games.map(g => g.options.filter(o => o.eligible))
const combos = []
for (const a of elig[0]) for (const b of elig[1]) for (const c of elig[2]) {
  const legs = [a, b, c], odds = a.odds * b.odds * c.odds
  combos.push({ legs, odds, pay: STAKE * odds * (1 + bonus(3)), p: a.p * b.p * c.p })
}
const band = combos.filter(x => x.pay >= TARGET && x.pay <= TARGET * (1 + BAND))
const allCombos = games.reduce((n, g) => n * g.options.length, 1)
console.log(`\n## The target band`)
console.log(`- all combinations (${games.map(g => g.options.length).join(' × ')} selections): **${allCombos.toLocaleString()}**`)
console.log(`- with every leg ≥ ${MIN_LEG} (bonus-eligible): **${combos.length.toLocaleString()}**`)
console.log(`- paying ₦${TARGET}–₦${(TARGET * (1 + BAND)).toFixed(0)} on ₦${STAKE} (3-leg bonus ${100 * bonus(3)}%): **${band.length}** combinations`)
if (!band.length) { console.log('no combination lands in the band — widen it or change the target'); process.exit(0) }
console.log(`- each pays ~₦${TARGET}; their win chances range ${(100 * Math.min(...band.map(x => x.p))).toFixed(2)}%–${(100 * Math.max(...band.map(x => x.p))).toFixed(2)}%`)

// ── 5. decision bot ───────────────────────────────────────────────────────────────
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
/** P(≥1 of these slips wins) — exact, by walking every scoreline triple (games independent). */
function pAny(slips) {
  const T = games.map(g => g.fit.T.filter(x => x[2] > 1e-5)); let s = 0
  for (const [h0, a0, p0] of T[0]) for (const [h1, a1, p1] of T[1]) for (const [h2, a2, p2] of T[2]) {
    const sc = [[h0, a0], [h1, a1], [h2, a2]]
    if (slips.some(sl => sl.legs.every((o, i) => o.pred(...sc[i])))) s += p0 * p1 * p2
  }
  return s
}
function bot(mode) {
  const r = rng(SEED); const log = []; const chosen = []
  for (let k = 0; k < K && chosen.length < band.length; k++) {
    let pick, why
    const pool = band.filter(x => !chosen.includes(x))
    if (mode === 'random') { const u = r(); pick = pool[Math.floor(u * pool.length)]; why = `random (u=${u.toFixed(3)}) among ${pool.length} in-band combos` }
    else if (mode === 'flip') {
      if (k === 0) { const u = r(); pick = pool[Math.floor(u * pool.length)]; why = `slip 1 random (u=${u.toFixed(3)})` }
      else {
        // flip as many of slip 1's legs as possible while staying in the band; tie → higher win chance
        const base = chosen[0]
        const flips = sl => sl.legs.filter((o, i) => o.name === base.legs[i].flip).length
        pool.sort((a, b) => flips(b) - flips(a) || b.p - a.p); pick = pool[0]; why = `flips ${flips(pick)}/3 of slip 1's picks, still in band`
      }
    } else {
      // greedy: the combo that adds the most NEW winning probability to the family
      const cur = pAny(chosen); let best = null
      for (const x of pool) { const g = pAny([...chosen, x]) - cur; if (!best || g > best.g) best = { x, g } }
      pick = best.x; why = `adds +${(100 * best.g).toFixed(2)}% to P(≥1 win) — the most of any in-band combo`
    }
    chosen.push(pick)
    log.push({ slip: k + 1, legs: pick.legs.map((o, i) => `G${i + 1}: ${o.name} @${o.odds}`), payout: +pick.pay.toFixed(2), pWin: +(100 * pick.p).toFixed(3), why })
  }
  return { chosen, log }
}
console.log(`\n## Decision bot — ${K} slips of ₦${STAKE} (seed ${SEED})`)
for (const mode of ['random', 'flip', 'greedy']) {
  const { chosen, log } = bot(mode)
  const p = pAny(chosen), ev = chosen.reduce((s, x) => s + x.p * x.pay, 0), staked = chosen.length * STAKE
  console.log(`\n### ${mode}: P(≥1 win) ${(100 * p).toFixed(2)}% · expected return ₦${ev.toFixed(1)} on ₦${staked} staked (keep ${(ev / staked).toFixed(3)})`)
  for (const l of log) console.log(`- slip ${l.slip}: ${l.legs.join(' · ')} → pays ₦${l.payout}, wins ${l.pWin}% — ${l.why}`)
}
console.log(`\nCeiling: even ALL ${band.length} in-band combos together win ${(100 * pAny(band)).toFixed(2)}% of the time, at a cost of ₦${band.length * STAKE}.`)

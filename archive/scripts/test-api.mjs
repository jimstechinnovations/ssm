/**
 * scripts/test-api.mjs
 *
 * SSM Gate Screener — Live API Test using odds-api.io
 *
 * Scans football fixtures for a given date, tests each one against
 * the available SSM bookmakers, finds the first 8 that pass all 4 gates,
 * and prints a clean summary report.
 *
 * Free plan: 2 bookmakers allowed (SportyBet, Stake)
 * To upgrade and add Betway/1xBet: https://odds-api.io/manage
 *
 * Run:               node scripts/test-api.mjs
 * Run specific date: node scripts/test-api.mjs 2026-06-21
 */

const ODD_API_KEY = 'fc1308c23e1f2625fe284d0ffb8f76bf3ff3276a9de834e4ff2fb660798bbe81'
const BASE        = 'https://api.odds-api.io'

// Bookmakers allowed on current plan — exact names as odds-api.io expects
// Free plan allows 2. Upgrade to add: Betway, 1xbet
const BOOKMAKERS = ['SportyBet', 'Stake']

// Gate thresholds — mirrors lib/ssm/gate-screener.ts exactly
const GATE_THRESHOLDS = {
  G1:  { desc: 'Over 0.5 < 1.15',     pass: (v) => v < 1.15  },
  G2:  { desc: 'Under 0.5 > 5.00',    pass: (v) => v > 5.00  },
  G3Y: { desc: 'BTTS Yes 1.50–1.80',  pass: (v) => v >= 1.50 && v <= 1.80 },
  G3N: { desc: 'BTTS No 1.80–2.20',   pass: (v) => v >= 1.80 && v <= 2.20 },
  G4:  { desc: 'DC 12 < 1.40',        pass: (v) => v < 1.40  },
}

const TARGET_DATE = process.argv[2] ?? new Date().toISOString().slice(0, 10)
const DELAY_MS    = 1000   // 1s between requests to avoid rate limiting

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function sep(label) {
  console.log('\n' + '═'.repeat(65))
  console.log(` ${label}`)
  console.log('═'.repeat(65))
}

async function apiFetch(path, params = {}) {
  const url = new URL(path, BASE)
  url.searchParams.set('apiKey', ODD_API_KEY)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }

  const res  = await fetch(url.toString())
  const text = await res.text()

  let json
  try { json = JSON.parse(text) } catch { return null }

  if (json?.error) {
    if (String(json.error).includes('rate') || res.status === 429) {
      console.log('\n  ⚠ Rate limit — waiting 10s...')
      await sleep(10000)
      return apiFetch(path, params)
    }
    console.log(`  API error: ${json.error}`)
    return null
  }

  return json
}

// ── Extract gate odds from odds-api.io market array ──────────────────────────
// The API returns markets like:
//   { name: "Over/Under", odds: [{ max: 0.5, over: "1.08", under: "7.40" }] }
//   { name: "Both Teams to Score", odds: [{ yes: "1.65", no: "2.00" }] }
//   { name: "Double Chance", odds: [{ "1x": "1.20", "12": "1.30", "x2": "1.90" }] }

function extractGateOdds(markets) {
  const odds = {
    'Over 0.5':  null,
    'Under 0.5': null,
    'BTTS Yes':  null,
    'BTTS No':   null,
    'DC 12':     null,
  }

  for (const market of (markets ?? [])) {
    const name = (market.name ?? '').toLowerCase().trim()

    // Over/Under — covers "Totals", "Total Goals", "Over/Under", "O/U"
    // The API uses { max: 0.5, over: "1.08", under: "7.40" } or { line: 0.5, ... }
    if (
      name.includes('total') || name.includes('over') ||
      name === 'ou' || name.includes('o/u') || name.includes('goals')
    ) {
      for (const o of (market.odds ?? [])) {
        const line = parseFloat(o.max ?? o.line ?? o.total ?? o.handicap ?? -1)
        if (Math.abs(line - 0.5) < 0.01) {
          if (o.over  !== undefined) odds['Over 0.5']  = parseFloat(o.over)
          if (o.under !== undefined) odds['Under 0.5'] = parseFloat(o.under)
        }
      }
    }

    // Both Teams to Score — covers "BTTS", "Both Teams to Score", "GG/NG"
    if (
      name.includes('both') || name.includes('btts') ||
      name.includes('bts') || name.includes('gg')
    ) {
      for (const o of (market.odds ?? [])) {
        if (o.yes !== undefined) odds['BTTS Yes'] = parseFloat(o.yes)
        if (o.no  !== undefined) odds['BTTS No']  = parseFloat(o.no)
      }
    }

    // Double Chance — we want "12" (Home or Away wins)
    if (name.includes('double') && name.includes('chance')) {
      for (const o of (market.odds ?? [])) {
        if (o['12'] !== undefined) odds['DC 12'] = parseFloat(o['12'])
      }
    }
  }

  return odds
}

// ── Evaluate all 4 gates ──────────────────────────────────────────────────────

function evaluateGates(odds) {
  const r = {
    G1:  { value: odds['Over 0.5'],  pass: odds['Over 0.5']  !== null && GATE_THRESHOLDS.G1.pass(odds['Over 0.5'])  },
    G2:  { value: odds['Under 0.5'], pass: odds['Under 0.5'] !== null && GATE_THRESHOLDS.G2.pass(odds['Under 0.5']) },
    G3Y: { value: odds['BTTS Yes'],  pass: odds['BTTS Yes']  !== null && GATE_THRESHOLDS.G3Y.pass(odds['BTTS Yes']) },
    G3N: { value: odds['BTTS No'],   pass: odds['BTTS No']   !== null && GATE_THRESHOLDS.G3N.pass(odds['BTTS No'])  },
    G4:  { value: odds['DC 12'],     pass: odds['DC 12']     !== null && GATE_THRESHOLDS.G4.pass(odds['DC 12'])     },
  }
  const qualified = r.G1.pass && r.G2.pass && r.G3Y.pass && r.G3N.pass && r.G4.pass
  return { gates: r, qualified }
}

function fmtOdds(val, pass) {
  if (val === null) return '—'.padEnd(9)
  return `${val.toFixed(2)}${pass ? '✓' : '✗'}`.padEnd(9)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  sep('SSM Gate Screener — Live API Test (odds-api.io)')
  console.log(` Date:        ${TARGET_DATE}`)
  console.log(` Bookmakers:  ${BOOKMAKERS.join(', ')} (free plan — upgrade for Betway + 1xBet)`)
  console.log(` Target:      Find 8 fixtures passing all 4 SSM gates`)

  // 1. Fetch all football events for the date
  sep('Step 1 — Fetching football fixtures')
  const events = await apiFetch('/v3/events', {
    sport: 'football',
    from:  `${TARGET_DATE}T00:00:00Z`,
    to:    `${TARGET_DATE}T23:59:59Z`,
    limit: '200',
  })

  if (!Array.isArray(events) || events.length === 0) {
    console.log(`\n No football fixtures found for ${TARGET_DATE}.`)
    const d = new Date(); const doy = d.getDay()
    const sat = new Date(d); sat.setDate(d.getDate() + ((6 - doy + 7) % 7 || 7))
    console.log(` Try a date with major league action: node scripts/test-api.mjs ${sat.toISOString().slice(0,10)}`)
    return
  }

  console.log(` Found ${events.length} football fixtures`)

  // 2. Screen each fixture
  sep('Step 2 — Screening against SSM gates')
  console.log(` Checking up to ${events.length} fixtures...\n`)

  const qualified = []
  let checked = 0
  let debugDone = false  // print raw market names once for diagnosis

  for (const event of events) {
    if (qualified.length >= 8) break

    checked++
    const home  = event.home
    const away  = event.away
    const league = event.league?.name ?? ''
    const kickoff = (event.date ?? '').slice(0, 16).replace('T', ' ')
    const eventId = event.id

    process.stdout.write(` [${checked}] ${home} vs ${away}\n`)

    let fixtureQualified = false

    for (const bmName of BOOKMAKERS) {
      await sleep(DELAY_MS)

      const oddsData = await apiFetch('/v3/odds', {
        eventId:     String(eventId),
        bookmakers:  bmName,
      })

      const markets = oddsData?.bookmakers?.[bmName]
      if (!markets || markets.length === 0) {
        console.log(`       ${bmName.padEnd(12)} — no odds`)
        continue
      }

      // Print raw market names once so we know what keys exist
      if (!debugDone) {
        debugDone = true
        console.log(`\n  [DEBUG] Raw market names from ${bmName}:`)
        markets.forEach(m => console.log(`    "${m.name}" — sample: ${JSON.stringify(m.odds?.[0]).slice(0,80)}`))
        console.log()
      }

      const odds = extractGateOdds(markets)
      const { gates, qualified: passes } = evaluateGates(odds)

      console.log(
        `       ${bmName.padEnd(12)} ` +
        `G1:${fmtOdds(gates.G1.value, gates.G1.pass)} ` +
        `G2:${fmtOdds(gates.G2.value, gates.G2.pass)} ` +
        `G3Y:${fmtOdds(gates.G3Y.value, gates.G3Y.pass)} ` +
        `G3N:${fmtOdds(gates.G3N.value, gates.G3N.pass)} ` +
        `G4:${fmtOdds(gates.G4.value, gates.G4.pass)}` +
        (passes ? '  ✅ ALL GATES PASS' : '')
      )

      if (passes && !fixtureQualified) {
        fixtureQualified = true
        qualified.push({ id: eventId, home, away, league, kickoff, bookmaker: bmName, odds })
        console.log(`       → ✅ QUALIFIED via ${bmName} (${qualified.length}/8 found)`)
      }
    }
  }

  // 3. Final report
  sep(`Results — ${qualified.length}/8 qualifying fixtures`)

  if (qualified.length === 0) {
    console.log('\n No fixtures passed all 4 SSM gates today.')
    const d = new Date(); const doy = d.getDay()
    const sat = new Date(d); sat.setDate(d.getDate() + ((6 - doy + 7) % 7 || 7))
    console.log(` Try: node scripts/test-api.mjs ${sat.toISOString().slice(0,10)}`)
    console.log('\n Note: BTTS and DC 12 markets are most common on competitive league matches.')
    console.log(' Avoid friendlies, qualifiers, and minor leagues.')
    return
  }

  console.log('')
  qualified.forEach((f, i) => {
    const o = f.odds
    console.log(` ${i + 1}. ${f.home} vs ${f.away}`)
    console.log(`    League:    ${f.league}`)
    console.log(`    Kickoff:   ${f.kickoff}`)
    console.log(`    Bookmaker: ${f.bookmaker}`)
    console.log(`    Over 0.5:  ${o['Over 0.5']}  |  Under 0.5: ${o['Under 0.5']}  |  BTTS Yes: ${o['BTTS Yes']}  |  BTTS No: ${o['BTTS No']}  |  DC 12: ${o['DC 12']}`)
    console.log('')
  })

  if (qualified.length >= 8) {
    console.log(' ✅ Full set of 8 qualifying fixtures found. Ready to generate a session.')
  } else {
    console.log(` ⚠  Only ${qualified.length}/8 found. Need a date with more major league matches.`)
  }

  console.log('\n' + '═'.repeat(65))
}

main().catch(err => {
  console.error('\nFatal error:', err.message)
  process.exit(1)
})

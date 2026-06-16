/**
 * scripts/probe-bookmakers.mjs
 * Discover bookmaker names available on odds-api.io and find Nigerian ones.
 * Run: node scripts/probe-bookmakers.mjs
 */

const KEY = 'fc1308c23e1f2625fe284d0ffb8f76bf3ff3276a9de834e4ff2fb660798bbe81'
const BASE = 'https://api.odds-api.io'

async function get(path, params = {}) {
  const url = new URL(path, BASE)
  url.searchParams.set('apiKey', KEY)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  console.log('  GET', url.toString())
  const r = await fetch(url.toString())
  const text = await r.text()
  console.log('  Status:', r.status)
  try {
    return JSON.parse(text)
  } catch {
    console.log('  Raw text:', text.slice(0, 300))
    return null
  }
}

async function main() {
  console.log('=== Step 1: Get all bookmaker names ===')
  const bms = await get('/v3/bookmakers', {})
  const names = Array.isArray(bms) ? bms.map(b => typeof b === 'string' ? b : b.name) : []
  console.log(`Total bookmakers: ${names.length}`)

  // Search for our SSM platforms
  const targets = ['betway', 'sporty', '1xbet', '1x', 'stake', 'nairabet', 'bet9ja', 'bangbet']
  console.log('\n--- Searching for SSM bookmakers ---')
  for (const t of targets) {
    const found = names.filter(n => n.toLowerCase().includes(t))
    console.log(`"${t}": ${found.length > 0 ? found.join(', ') : 'NOT FOUND'}`)
  }

  console.log('\n--- Full bookmaker list (sorted) ---')
  names.sort().forEach(n => console.log(' -', n))

  console.log('\n=== Step 2: Get today football events ===')
  const today = new Date().toISOString().slice(0, 10)
  const events = await get('/v3/events', {
    sport: 'football',
    from: `${today}T00:00:00Z`,
    to: `${today}T23:59:59Z`,
    limit: '10'
  })
  if (Array.isArray(events) && events.length > 0) {
    console.log(`Found ${events.length} events`)
    const firstId = events[0].id
    console.log(`First event: [${firstId}] ${events[0].home} vs ${events[0].away}`)

    // Try odds with first 3 bookmakers from the list
    if (names.length > 0) {
      const testBms = names.slice(0, 3).join(',')
      console.log(`\n=== Step 3: Fetch odds with bookmakers: ${testBms} ===`)
      const odds = await get('/v3/odds', { eventId: String(firstId), bookmakers: testBms })
      console.log('Odds response sample:', JSON.stringify(odds).slice(0, 800))
    }
  }
}

main().catch(console.error)

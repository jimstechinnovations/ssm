/**
 * scripts/build-teamtotal-code.mjs — one-off: take the 17-leg "no Under" slip and swap every
 * DNB/1X2 leg for the named team's "Over 0.5" team-total market (Home O/U = marketId 19,
 * Away O/U = marketId 20, both specifier total=0.5, outcomeId 12 = Over), then get a public
 * SportyBet booking code for it via /orders/share. Places nothing.
 *
 * Run: node scripts/build-teamtotal-code.mjs
 */
const legs = [
  { fixtureId: 66299430, game: 'Atlanta United FC vs Charlotte FC', marketId: '19', specifier: 'total=0.5', outcomeId: '12', label: 'Atlanta United Over 0.5', odds: 1.21 },
  { fixtureId: 66299436, game: 'Inter Miami CF vs CF Montreal', marketId: '10', specifier: '', outcomeId: '9', label: 'Inter Miami or Draw (DC 1X) — HOU 0.5 market still suspended', odds: 1.13 },
  { fixtureId: 66299438, game: 'New York Red Bulls vs Philadelphia Union', marketId: '20', specifier: 'total=0.5', outcomeId: '12', label: 'Philadelphia Union Over 0.5', odds: 1.15 },
  { fixtureId: 72041094, game: 'FC Utrecht vs PSV Eindhoven', marketId: '20', specifier: 'total=0.5', outcomeId: '12', label: 'PSV Over 0.5', odds: 1.08 },
  { fixtureId: 72221222, game: 'Leeds United vs Brentford', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.29 },
  { fixtureId: 72221228, game: 'Sunderland AFC vs Fulham', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.34 },
  { fixtureId: 72513154, game: 'Freiburg vs Werder Bremen', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.24 },
  { fixtureId: 72041100, game: 'SC Telstar vs Ajax', marketId: '20', specifier: 'total=0.5', outcomeId: '12', label: 'Ajax Over 0.5', odds: 1.08 },
  { fixtureId: 72478520, game: 'Real Madrid vs Malaga CF', marketId: '16', specifier: 'hcp=-1.5', outcomeId: '1714', label: 'Real Madrid (-1.5)', odds: 1.35 },
  { fixtureId: 72036142, game: 'Rennes vs Le Mans FC', marketId: '19', specifier: 'total=0.5', outcomeId: '12', label: 'Rennes Over 0.5', odds: 1.09 },
  { fixtureId: 72513156, game: 'Augsburg vs Schalke', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.23 },
  { fixtureId: 71945222, game: 'Napoli vs Como 1907', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.44 },
  { fixtureId: 71945208, game: 'Cagliari vs Inter', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.28 },
  { fixtureId: 71945214, game: 'Lazio vs Genoa', marketId: '19', specifier: 'total=0.5', outcomeId: '12', label: 'Lazio Over 0.5', odds: 1.31 },
  { fixtureId: 72036138, game: 'Monaco vs Marseille', marketId: '19', specifier: 'total=0.5', outcomeId: '12', label: 'Monaco Over 0.5', odds: 1.20 },
  { fixtureId: 72478508, game: 'Celta vs Athletic Bilbao', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.37 },
  { fixtureId: 72478510, game: 'RC Deportivo De La Coruna vs Valencia', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.47 },
  { fixtureId: 66299448, game: 'Nashville SC vs FC Cincinnati', marketId: '19', specifier: 'total=0.5', outcomeId: '12', label: 'Nashville Over 0.5', odds: 1.12 },
  { fixtureId: 72221216, game: 'Chelsea vs Brighton', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.22 },
  { fixtureId: 72036140, game: 'Paris FC vs Nice', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.33 },
  { fixtureId: 72221226, game: 'Man Utd vs Ipswich Town', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.20 },
]

const combinedOdds = legs.reduce((p, l) => p * l.odds, 1)
console.log(`${legs.length} legs, combined odds ${combinedOdds.toFixed(2)}x`)

const selections = legs.map(l => ({ eventId: `sr:match:${l.fixtureId}`, marketId: l.marketId, specifier: l.specifier, outcomeId: l.outcomeId }))

const res = await fetch('https://www.sportybet.com/api/ng/orders/share', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', platform: 'web' },
  body: JSON.stringify({ selections, shareType: 1 }),
})
const json = await res.json()
if (json.bizCode !== 10000 || !json.data?.shareCode) {
  console.error(`Booking code FAILED (bizCode ${json.bizCode}):`, JSON.stringify(json).slice(0, 800))
  process.exit(1)
}
console.log(`\nBooking code: ${json.data.shareCode}`)
console.log(`URL: ${json.data.shareURL ?? `https://www.sportybet.com/ng/?shareCode=${json.data.shareCode}`}`)

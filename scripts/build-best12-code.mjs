/**
 * scripts/build-best12-code.mjs — curated highest-confidence subset (12 of the 21 games),
 * ranked by devigged true probability, greedily accumulated to ~5-6x combined. Booking-code
 * preview only, places nothing.
 *
 * Run: node scripts/build-best12-code.mjs
 */
const legs = [
  { fixtureId: 72041094, game: 'FC Utrecht vs PSV Eindhoven', marketId: '20', specifier: 'total=0.5', outcomeId: '12', label: 'PSV Over 0.5', odds: 1.08, prob: 0.9044 },
  { fixtureId: 72041100, game: 'SC Telstar vs Ajax', marketId: '20', specifier: 'total=0.5', outcomeId: '12', label: 'Ajax Over 0.5', odds: 1.08, prob: 0.8998 },
  { fixtureId: 72036142, game: 'Rennes vs Le Mans FC', marketId: '19', specifier: 'total=0.5', outcomeId: '12', label: 'Rennes Over 0.5', odds: 1.09, prob: 0.8921 },
  { fixtureId: 66299448, game: 'Nashville SC vs FC Cincinnati', marketId: '19', specifier: 'total=0.5', outcomeId: '12', label: 'Nashville Over 0.5', odds: 1.13, prob: 0.8657 },
  { fixtureId: 66299436, game: 'Inter Miami CF vs CF Montreal', marketId: '10', specifier: '', outcomeId: '9', label: 'Inter Miami or Draw (DC)', odds: 1.13, prob: 0.8570 },
  { fixtureId: 66299438, game: 'New York Red Bulls vs Philadelphia Union', marketId: '20', specifier: 'total=0.5', outcomeId: '12', label: 'Philadelphia Over 0.5', odds: 1.14, prob: 0.8524 },
  { fixtureId: 72036138, game: 'Monaco vs Marseille', marketId: '19', specifier: 'total=0.5', outcomeId: '12', label: 'Monaco Over 0.5', odds: 1.20, prob: 0.8093 },
  { fixtureId: 66299430, game: 'Atlanta United FC vs Charlotte FC', marketId: '19', specifier: 'total=0.5', outcomeId: '12', label: 'Atlanta United Over 0.5', odds: 1.21, prob: 0.8035 },
  { fixtureId: 72221226, game: 'Man Utd vs Ipswich Town', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.20, prob: 0.803 },
  { fixtureId: 72221216, game: 'Chelsea vs Brighton', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.22, prob: 0.787 },
  { fixtureId: 72513156, game: 'Augsburg vs Schalke', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.23, prob: 0.782 },
  { fixtureId: 72513154, game: 'Freiburg vs Werder Bremen', marketId: '18', specifier: 'total=1.5', outcomeId: '12', label: 'Over 1.5', odds: 1.24, prob: 0.774 },
]

const combinedOdds = legs.reduce((p, l) => p * l.odds, 1)
const combinedProb = legs.reduce((p, l) => p * l.prob, 1)
console.log(`${legs.length} legs, combined odds ${combinedOdds.toFixed(2)}x, combined true probability ${(combinedProb * 100).toFixed(2)}%`)

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

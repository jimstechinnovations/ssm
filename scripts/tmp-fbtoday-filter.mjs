import { readFileSync, writeFileSync } from 'node:fs'
const pool = JSON.parse(readFileSync('.fbtoday-picks.json', 'utf8'))

const EXCLUDE_GAMES = new Set([
  'Delfino Pescara vs US Sambenedettese',
  'Potenza Calcio vs Scafatese Calcio 1922',
  'MVV Maastricht vs Vitesse Arnhem',
  'Club Atletico La Paz vs Piratas Veracruz',
  'Skara FC vs Eskilsminne IF',
  'Canberra United FC vs Brisbane Roar FC',
  'ADO Den Haag vs de Graafschap',
  'FC Twente Enschede W vs PSV Eindhoven',
  'Watford LFC vs Ipswich Town Lfc',
  'Aston Villa WFC vs Birmingham City WFC',
  'Burnley FC Women vs Southampton FC',
  'Nottingham Forest Lfc vs Leicester City WFC',
  'CD Manacor vs UD Alcudia',
  'Aguilas de la Universidad de Panama vs Veraguas United FC B',
  'FC Lorentzweiler vs Berdenia Berbourg',
  'Birkenhead United AFC vs Eastern Suburbs AFC',
  'MSK Zilina B vs FK Inter Bratislava',
  'Defensor SC Montevideo vs Liverpool FC Montevideo',
  'Celtic LFC vs Rangers LFC',
  'Sampaio Correa FE RJ vs Madureira EC RJ',
  'PAOK Thessaloniki vs Panathinaikos',
  'Bourges 18 vs AS Cannes',
  'CD Tenerife vs AD Huracan',
  'Stade Reims vs Clermont Foot Youth',
  'CS Sedan-Ardennes vs Bourges FC',
  'CA Nacional Potosi vs Real Potosi',
  'Asa Aarhus vs Broendby IF',
  'Always Ready vs Independiente Petrolero',
  'Milford FC Reserve vs Kaizer Chiefs',
  'Montpellier Atlas Paillade vs AS Cannes',
  'Kagoshima United vs Gainare Tottori', // J3 League, combined recent GF ~1.2 — same risk pattern as the KE2V64 loss
  'Kamatamare Sanuki vs Renofa Yamaguchi', // J3 League, combined recent GF ~2.0 — right on the 1.5 line
  'Spezia Calcio vs Vado FC', // Serie C, no data
  'Ravenna FC 1913 vs Forli FC', // Serie C, no data
  'FC Imabari vs Jubilo Iwata', // J2 League, away gf0.6 last 5 — low scoring
  'FC Ryukyu vs Kochi United SC', // J3 League, no data
])

// Blanket exclude: Japanese J2/J3 league fixtures (not J.League Cup) — proven low-scoring risk pattern
const filtered = pool.filter(p => !EXCLUDE_GAMES.has(p.game) && !/^J2 League$|^J3 League$/.test(p.league))
writeFileSync('.fbtoday-picks-filtered.json', JSON.stringify(filtered, null, 2))
console.log('kept', filtered.length, 'of', pool.length, '(-' + (pool.length - filtered.length) + ' excluded)')

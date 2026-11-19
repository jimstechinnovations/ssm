import { writeFileSync } from 'node:fs'
const fids = ['73696984','73696986','73696990','73696988','73696992','73696994','73696996','73696998','73697000']
const out = []
for (const fid of fids) {
  let ev = null
  for (const pid of [3,1]) {
    const r = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=sr:match:${fid}&productId=${pid}`, { headers: { Accept: 'application/json' } })
    const j = await r.json()
    if (j.data && j.data.markets && j.data.markets.length) { ev = j.data; break }
  }
  out.push({ fid, game: ev.homeTeamName+' vs '+ev.awayTeamName, markets: ev.markets })
  await new Promise(r=>setTimeout(r,80))
}
writeFileSync('.nba-detail.json', JSON.stringify(out))
for (const g of out) {
  console.log('===', g.game)
  const hcps = g.markets.filter(m=>m.id==='223')
  for (const m of hcps.slice(0,1)) {} // just show full range below
  const h = g.markets.filter(m=>m.id==='223').map(m=>{
    const home=m.outcomes.find(o=>/Home/.test(o.desc)); const away=m.outcomes.find(o=>/Away/.test(o.desc));
    return m.specifier+' H@'+(home?.odds)+'('+(home?(+home.probability*100).toFixed(0):'')+'%) A@'+(away?.odds)+'('+(away?(+away.probability*100).toFixed(0):'')+'%)';
  });
  console.log(' HCP:', h.join(' | '));
  const o = g.markets.filter(m=>m.id==='225').map(m=>{
    const over=m.outcomes.find(o=>/Over/.test(o.desc)); const under=m.outcomes.find(o=>/Under/.test(o.desc));
    return m.specifier+' O@'+(over?.odds)+'('+(over?(+over.probability*100).toFixed(0):'')+'%) U@'+(under?.odds)+'('+(under?(+under.probability*100).toFixed(0):'')+'%)';
  });
  console.log(' OU:', o.join(' | '));
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const res = await fetch('https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr:sport:1&marketId=16&pageSize=5&pageNum=1', { headers: { 'User-Agent': UA, Accept: 'application/json' } })
const json = await res.json()
const ev = json.data.tournaments[0].events[0]
for (const m of ev.markets || []) console.log(m.id, m.desc, '|', m.name, '|', m.specifier, '|', m.outcomes.map(o => o.desc + ':' + o.odds))

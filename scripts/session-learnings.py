# scripts/session-learnings.py — what the settled Decision Bot sessions say about the bot.
# Re-run after every session and copy the numbers into docs/learnings.md (the session log there).
#
#   python scripts/session-learnings.py                       # every session with placed slips
#   python scripts/session-learnings.py S-3EC9BA S-222131     # just these
#   BASE=http://localhost:3000 python scripts/session-learnings.py
#
# Needs the app running (it reads /api/sessions, /survival for final scores, and slips with legs).
# Legacy Under-4.5 sessions (legs without a `rule`) are skipped — only Decision Bot legs are graded.
#
# Two levels, on purpose:
#   1. LEG level — every leg of every placed slip on a finished game. Big samples, but the same game
#      appears under many slips, so z-scores here OVERSTATE certainty (a leg-level z=-4 on "Home or Away"
#      shrank to z=+1.4 once each game was counted once — 2026-10-02).
#   2. GAME level — each game counted once. This is the test to believe.
import json, math, os, re, subprocess, sys
from collections import defaultdict

BASE = os.environ.get('BASE', 'http://localhost:3000')
get = lambda path: json.loads(subprocess.run(['curl', '-s', '-m', '180', BASE + path], capture_output=True, text=True).stdout)

def wins(r, h, a):
    k = r['kind']
    if k == 'total': return h + a > r['line'] if r['side'] == 'Over' else h + a < r['line']
    if k == 'team_total':
        g = h if r['team'] == 'home' else a
        return g > r['line'] if r['side'] == 'Over' else g < r['line']
    if k == '1x2': return h > a if r['pick'] == 'H' else (a > h if r['pick'] == 'A' else h == a)
    if k == 'dc': return h >= a if r['pick'] == 'HD' else (a >= h if r['pick'] == 'DA' else h != a)
    if k == 'btts': return (h > 0 and a > 0) == r['yes']
    if k == 'odd_even': return ((h + a) % 2 == 1) == r['odd']
    if k == 'clean_sheet': return ((a if r['team'] == 'home' else h) == 0) == r['yes']

codes = sys.argv[1:] or [s['code'] for s in get('/api/sessions?limit=200')['sessions'] if (s.get('summary') or {}).get('placed')]
legs, slips, games = [], [], {}
for code in codes:
    sv = get(f'/api/sessions/{code}/survival')
    if 'curve' not in sv: continue
    res = {c['fixtureId']: tuple(map(int, c['score'].split('-'))) for c in sv['curve'] if c['finished'] and c.get('score')}
    full = get(f'/api/sessions/{code}?withLegs=1&limit=2000')
    for sl in full.get('slips', []):
        if sl['status'] not in ('placed', 'lost', 'won'): continue
        decided = []
        for l in sl.get('legs') or []:
            if l.get('suspended') or not l.get('rule'): continue
            p = l.get('p') or 1 / l['odds']
            fid = l['fixtureId']
            if fid not in res: continue
            h, a = res[fid]
            legs.append(dict(l, won=wins(l['rule'], h, a), p=p, sess=code)); decided.append(p)
            g = games.setdefault(fid, {'score': res[fid], 'league': l.get('league', ''), 'pD': [], 'pO25': [], 'pBTTS': []})
            r = l['rule']
            if r['kind'] == '1x2' and r['pick'] == 'D': g['pD'].append(p)
            if r['kind'] == 'dc' and r['pick'] == 'HA': g['pD'].append(1 - p)
            if r['kind'] == 'total' and r['line'] == 2.5: g['pO25'].append(p if r['side'] == 'Over' else 1 - p)
            if r['kind'] == 'btts': g['pBTTS'].append(p if r['yes'] else 1 - p)
        slips.append((code, sl['slipId'], sl['status'], decided))

if not legs: sys.exit('no graded Decision Bot legs yet (games unfinished, or only legacy sessions)')
n = len(legs); w = sum(l['won'] for l in legs); p = sum(l['p'] for l in legs)
print(f'sessions: {", ".join(codes)}')
print(f'\nCALIBRATION  legs graded {n}: won {100*w/n:.1f}%, bot predicted {100*p/n:.1f}%')
exp_alive = sum(math.prod(sp) for *_, sp in slips)
print(f'             slips {len(slips)}: alive/won now {sum(1 for s in slips if s[2] in ("placed","won"))}, bot expected {exp_alive:.1f}')

def table(title, keyf, minn=15):
    g = defaultdict(list)
    for l in legs: g[keyf(l)].append(l)
    print(f'\n== {title} (LEG level — z overstated, see header)   legs | actual | predicted | diff')
    for k, ls in sorted(g.items(), key=lambda x: -len(x[1])):
        if len(ls) < minn: continue
        a = sum(l['won'] for l in ls); e = sum(l['p'] for l in ls); v = sum(l['p'] * (1 - l['p']) for l in ls)
        print(f'  {str(k)[:34]:34} {len(ls):5} {100*a/len(ls):6.1f}% {100*e/len(ls):6.1f}% {100*(a-e)/len(ls):+6.1f}pt  z={(a-e)/math.sqrt(max(v,1e-9)):+.1f}')

def market(l):
    r = l['rule']; k = r['kind']
    if k in ('total', 'team_total'): return f"{k} {r.get('team', '')} {r['side']}".replace('  ', ' ')
    if k == '1x2': return f"1x2 {r['pick']}"
    if k == 'dc': return f"dc {r['pick']}"
    if k == 'btts': return f"btts {'yes' if r['yes'] else 'no'}"
    if k == 'odd_even': return f"odd_even {'odd' if r['odd'] else 'even'}"
    return f"clean_sheet {'yes' if r['yes'] else 'no'}"
BANDS = [(1, 1.2), (1.2, 1.5), (1.5, 2), (2, 3), (3, 5), (5, 8), (8, 15), (15, 999)]
NAT = re.compile(r'international|world cup|qualif|nations|friendl|euro', re.I)
def reason(l):
    w = l.get('why', '')
    return 'separator' if 'separator' in w else 'random' if 'random pick' in w else 'weighted' if 'weighted' in w else 'other'
def history(l):
    m = re.search(r'history: (\d+)/(\d+) past meetings', l.get('why', ''))
    if not m: return 'no H2H history'
    return 'H2H agreed (>=50%)' if int(m.group(1)) / int(m.group(2)) >= 0.5 else 'H2H disagreed (<50%)'
table('MARKET', market)
table('ODDS BAND', lambda l: next(f'{a}-{b}' for a, b in BANDS if a <= l['odds'] < b))
table('LEAGUE TYPE', lambda l: 'internationals' if NAT.search(l.get('league', '')) else 'clubs')
table('PICK REASON', reason)
table('HISTORY CITED IN REASON', history)

print(f'\n== GAME level (each game once — the test to believe), {len(games)} finished games')
def test(name, key, happened):
    gs = [g for g in games.values() if g[key]]
    if not gs: return
    pr = [sum(g[key]) / len(g[key]) for g in gs]
    act = sum(happened(*g['score']) for g in gs); e = sum(pr); v = sum(x * (1 - x) for x in pr)
    print(f'  {name:18} games {len(gs):4}  happened {act:4} ({100*act/len(gs):5.1f}%)  expected {e:6.1f} ({100*e/len(gs):5.1f}%)  z={(act-e)/math.sqrt(max(v,1e-9)):+.1f}')
test('DRAW', 'pD', lambda h, a: h == a)
test('OVER 2.5', 'pO25', lambda h, a: h + a > 2.5)
test('BOTH SCORE', 'pBTTS', lambda h, a: h > 0 and a > 0)

# ── WATCH LIST — the leans we track before changing anything (docs/learnings.md). A lean only becomes an
# action when it holds at |z| >= 2 over at least MIN_GAMES games, counted once per game. Run with no
# session codes for the cumulative verdict across every Decision Bot session.
MIN_GAMES, Z_ACT = 150, 2.0
def verdict(name, key, happened, action):
    gs = [g for g in games.values() if g[key]]
    if not gs: return f'  {name:12} no games yet'
    pr = [sum(g[key]) / len(g[key]) for g in gs]
    act = sum(happened(*g['score']) for g in gs); e = sum(pr); z = (act - e) / math.sqrt(max(sum(x * (1 - x) for x in pr), 1e-9))
    head = f'  {name:12} {len(gs):4} games  {act} happened vs {e:.1f} expected  z={z:+.1f}  → '
    if len(gs) < MIN_GAMES: return head + f'WATCHING ({len(gs)}/{MIN_GAMES} games{"; leaning " + ("more" if z > 0 else "less") if abs(z) >= 1 else ""})'
    if abs(z) >= Z_ACT: return head + f'ACT: {action}'
    return head + 'no lean — leave the pricing alone'
print(f'\n== WATCH LIST (act only at |z| >= {Z_ACT} over >= {MIN_GAMES} games; sessions: {len(codes)})')
print(verdict('DRAWS', 'pD', lambda h, a: h == a, 'add a draw correction (Dixon-Coles) to the scoreline table'))
print(verdict('OVER 2.5', 'pO25', lambda h, a: h + a > 2.5, 'shift the goal-total prices toward the observed rate'))
print(verdict('BOTH SCORE', 'pBTTS', lambda h, a: h > 0 and a > 0, 'adjust both-teams-score prices'))
z_all = (w - p) / math.sqrt(max(sum(l['p'] * (1 - l['p']) for l in legs), 1e-9))
print(f'  {"LEG CALIB.":12} {n:4} legs  won {100*w/n:.1f}% vs {100*p/n:.1f}% predicted  z={z_all:+.1f} (leg level, overstated)  → '
      + ('fine' if abs(z_all) < 3 else 'CHECK: the leg probabilities are off — compare against the game-level lines above'))

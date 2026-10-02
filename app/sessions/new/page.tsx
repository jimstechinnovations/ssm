'use client'
/**
 * app/sessions/new/page.tsx — New session.
 * Three inputs that matter (book, dates, budget → target); the engine computes everything else. The
 * right-hand panel shows what the budget buys BEFORE you build, and after building shows the honest
 * result: the modelled chance that ≥1 slip lands, and what the bookmaker's price keeps on average.
 * Builds are always history-informed (only games with form for both teams) — never history-blind.
 */
import React, { useEffect, useState } from 'react'
import { Page, PageHeader, Card, Field, Button, LinkButton, Banner, Stat, Badge, inputCls, naira, pct, cx } from '@/components/ui'

interface BookConfig { bookId: string; label: string; minStake: number; enabled: boolean; registered: boolean; feedVerified: boolean }
interface BuiltBook { bookId: string; slips?: number; legs?: number; pAnyWin?: number; medianPayout?: number; withHistory?: number; keepRate?: number; expectedNet?: number; legRange?: { min: number; max: number }; windowWarning?: string; note?: string; error?: string; detail?: string }
interface SessionResult {
  session: { code: string; status: string; legCount: number | null; slipCount: number | null; poolSize: number | null; budget: number; targetWin: number; minStake: number; dateTo: string }
  books: BuiltBook[]
  placement?: { runMinutes: number; windowMin: number }
}

const todayPlus = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10)
const hrs = (m: number) => m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m} min`
const RULE_HINT: Record<string, string> = {
  greedy: 'Each slip is the candidate that adds the most to the chance ≥1 slip wins — it prefers slips whose winning scorelines never overlap earlier slips.',
  weighted: 'Picks likelier selections more often. Tends to use more, cheaper legs.',
  random: 'Uniform random picks within the rules. A useful baseline.',
  flip: 'Slip 1 random; each later slip flips the previous slip\'s picks where the band allows. Overlaps more than greedy.',
}
const PRESETS = [{ b: 1000, t: 100_000 }, { b: 2000, t: 200_000 }, { b: 5000, t: 500_000 }]

export default function NewSessionPage() {
  const [books, setBooks] = useState<BookConfig[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [dateFrom, setDateFrom] = useState(todayPlus(0))
  const [dateTo, setDateTo] = useState(todayPlus(1))
  const [budget, setBudget] = useState(1000)
  const [target, setTarget] = useState(100_000)
  const [advanced, setAdvanced] = useState(false)
  const [windowMin, setWindowMin] = useState<number | ''>('')
  const [maxDays, setMaxDays] = useState<number | ''>('')
  const [skipFriendlies, setSkipFriendlies] = useState(false)
  // Decision Bot (default engine) — defaults: greedy, 1% band, legs under 1.20 allowed
  const [engine, setEngine] = useState<'decision_bot' | 'multi_market'>('decision_bot')
  const [rule, setRule] = useState<'greedy' | 'weighted' | 'random' | 'flip'>('greedy')
  const [bandPct, setBandPct] = useState(1)
  const [allowSubMin, setAllowSubMin] = useState(true)
  const [seed, setSeed] = useState<number | ''>('')
  const [floorShare, setFloorShare] = useState(0)   // share of the budget on floor tickets (docs/near-miss-design.md)
  const [building, setBuilding] = useState(false)
  const [result, setResult] = useState<SessionResult | null>(null)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const cfgs: BookConfig[] = (await (await fetch('/api/config')).json()).configs ?? []
        setBooks(cfgs.filter(c => c.registered))
        const def = cfgs.find(c => c.bookId === 'sportybet') ?? cfgs.find(c => c.registered)
        if (def) setSelected([def.bookId])
      } catch { setError({ title: 'Could not load bookmakers', detail: 'Is the database reachable? (A paused Supabase project must be restored first.)' }) }
    })()
  }, [])

  const minStake = Math.max(1, ...books.filter(b => selected.includes(b.bookId)).map(b => b.minStake))
  const slips = Math.floor(budget / minStake)
  const runMin = Math.ceil((slips * 20) / 60)
  const autoWindow = Math.max(60, runMin + 75)
  const multiple = target / Math.max(1, minStake)

  async function build() {
    if (selected.length === 0) { setError({ title: 'Pick a bookmaker' }); return }
    setBuilding(true); setError(null); setResult(null)
    try {
      const body: Record<string, unknown> = { books: selected, date_from: dateFrom, date_to: dateTo, budget, target_win: target, require_history: true }
      if (windowMin) body.selection_window_min = windowMin
      if (maxDays) body.max_window_days = maxDays
      if (skipFriendlies) body.exclude_leagues = ['friendl']
      body.engine = engine
      // skip + an 8-leg cap: fewer, higher-odds legs from the whole day (benched +26% win chance, 2026-10-01)
      if (engine === 'decision_bot') { body.rule = rule; body.band_pct = bandPct; body.allow_sub_min_legs = allowSubMin; body.skip = true; body.max_legs = 8; body.floor_share = floorShare; if (seed !== '') body.seed = seed }
      const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json()
      if (!r.ok) {
        const failed = (j.books as BuiltBook[] | undefined)?.find(b => b.error)
        setError(failed ? { title: failed.error!, detail: failed.detail } : { title: j.error || 'Build failed', detail: j.issues?.join('; ') })
        return
      }
      setResult(j)
    } catch { setError({ title: 'Network error building the session' }) }
    finally { setBuilding(false) }
  }

  return (
    <Page>
      <PageHeader back={{ href: '/', label: 'Sessions' }} title="New session" subtitle="Set the money. The builder picks the games, the markets and how many legs each slip needs to reach your target." />

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Card title="1 · Bookmaker">
            <div className="flex flex-wrap gap-2">
              {books.length === 0 && <span className="text-sm text-zinc-500">Loading…</span>}
              {books.map(b => {
                const on = selected.includes(b.bookId)
                return (
                  <button key={b.bookId} onClick={() => setSelected(s => on ? s.filter(x => x !== b.bookId) : [...s, b.bookId])}
                    className={cx('rounded-xl border px-4 py-2.5 text-left transition', on
                      ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                      : 'border-zinc-300 text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300')}>
                    <div className="text-sm font-medium">{b.label}</div>
                    <div className={cx('text-[11px]', on ? 'opacity-70' : 'text-zinc-500')}>min stake {naira(b.minStake)}{b.feedVerified ? '' : ' · feed unverified'}</div>
                  </button>
                )
              })}
            </div>
          </Card>

          <Card title="2 · When" subtitle="Games kicking off in this window. Shorter windows settle sooner.">
            <div className="grid grid-cols-2 gap-4">
              <Field label="From"><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={inputCls} /></Field>
              <Field label="To (max +2 days)"><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={inputCls} /></Field>
            </div>
          </Card>

          <Card title="3 · Money" subtitle="Budget is split into minimum-stake slips. Every slip is built to pay at least the target if it wins.">
            <div className="mb-4 flex flex-wrap gap-2">
              {PRESETS.map(p => (
                <button key={p.b} onClick={() => { setBudget(p.b); setTarget(p.t) }}
                  className={cx('rounded-full border px-3 py-1 text-xs font-medium transition', budget === p.b && target === p.t
                    ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                    : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300')}>
                  {naira(p.b)} → {naira(p.t)}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Budget (₦)" hint={`${slips.toLocaleString()} slips of ${naira(minStake)}`}>
                <input type="number" min={10} step={100} value={budget} onChange={e => setBudget(+e.target.value)} className={inputCls} />
              </Field>
              <Field label="Target win per slip (₦)" hint={`${Math.round(multiple).toLocaleString()}× the stake`}>
                <input type="number" min={100} step={10000} value={target} onChange={e => setTarget(+e.target.value)} className={inputCls} />
              </Field>
            </div>

            {engine === 'decision_bot' && (
              <div className="mt-4">
                <Field label="Floor (money back on a losing day)" hint={floorShare === 0
                  ? 'Off: every naira chases the target. A day without a winning slip returns nothing.'
                  : `${naira(budget * floorShare)} on ${Math.floor(budget * floorShare / Math.max(1, minStake))} Flexi tickets ("at least k of 8" on likely legs). On a day with no jackpot, about ${naira(budget * floorShare * 0.9)} comes back on average; the jackpot chance drops to about ${Math.round(100 * (1 - floorShare))}% of what the full budget would buy. Measured on our real games: 89% of floor stakes came back.`}>
                  <div className="flex flex-wrap gap-2">
                    {[0, 0.1, 0.25, 0.5].map(f => (
                      <button key={f} type="button" onClick={() => setFloorShare(f)}
                        className={cx('rounded-lg border px-3 py-1.5 text-sm', floorShare === f ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900' : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800')}>
                        {f === 0 ? 'None' : `${Math.round(f * 100)}%`}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            )}

            <button onClick={() => setAdvanced(v => !v)} className="mt-4 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
              {advanced ? '▾' : '▸'} Advanced
            </button>
            {advanced && (
              <div className="mt-3 grid grid-cols-1 gap-4 rounded-xl bg-zinc-50 p-4 sm:grid-cols-2 dark:bg-zinc-950/60">
                <Field label="Selection window (minutes)" hint={`Only games kicking off after this. Auto = placement time + 75 min (≈ ${hrs(autoWindow)}).`}>
                  <input type="number" min={15} max={600} placeholder="auto" value={windowMin} onChange={e => setWindowMin(e.target.value ? +e.target.value : '')} className={inputCls} />
                </Field>
                <Field label="Never select games more than N days out" hint="If the window has too few games the builder may reach further — it will say so.">
                  <input type="number" min={1} max={30} placeholder="30" value={maxDays} onChange={e => setMaxDays(e.target.value ? +e.target.value : '')} className={inputCls} />
                </Field>
                <label className="flex items-start gap-2 text-sm text-zinc-700 sm:col-span-2 dark:text-zinc-300">
                  <input type="checkbox" className="mt-0.5" checked={skipFriendlies} onChange={e => setSkipFriendlies(e.target.checked)} />
                  <span>Skip friendlies <span className="block text-xs text-zinc-500">Friendlies went 5+ goals far more often than competitive games in our settled sessions.</span></span>
                </label>
              </div>
            )}
          </Card>
          <Card title="4 · How slips are chosen" subtitle="The Decision Bot walks the games in a fixed order and stops each slip the moment its payout lands in your band. Every pick is logged with its reason.">
            <div className="mb-4 flex flex-wrap gap-2">
              {([['decision_bot', 'Decision Bot', 'any market, every pick explained'], ['multi_market', 'Totals coverage', 'the previous engine (Over/Under only)']] as const).map(([id, label, sub]) => (
                <button key={id} onClick={() => setEngine(id)}
                  className={cx('rounded-xl border px-4 py-2.5 text-left transition', engine === id
                    ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                    : 'border-zinc-300 text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300')}>
                  <div className="text-sm font-medium">{label}</div>
                  <div className={cx('text-[11px]', engine === id ? 'opacity-70' : 'text-zinc-500')}>{sub}</div>
                </button>
              ))}
            </div>
            {engine === 'decision_bot' && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Pick rule" hint={RULE_HINT[rule]}>
                  <select value={rule} onChange={e => setRule(e.target.value as typeof rule)} className={inputCls}>
                    <option value="greedy">Greedy — best chance, slips that can&apos;t both lose (default)</option>
                    <option value="weighted">Weighted random — likelier picks more often</option>
                    <option value="random">Random</option>
                    <option value="flip">Flip — each slip flips the previous slip&apos;s picks</option>
                  </select>
                </Field>
                <Field label="Payout band above target (%)" hint={`Every slip pays ${naira(target)}–${naira(target * (1 + bandPct / 100))} if it wins.`}>
                  <input type="number" min={0.1} max={25} step={0.5} value={bandPct} onChange={e => setBandPct(Math.max(0.1, +e.target.value || 1))} className={inputCls} />
                </Field>
                <label className="flex items-start gap-2 text-sm text-zinc-700 sm:col-span-2 dark:text-zinc-300">
                  <input type="checkbox" className="mt-0.5" checked={allowSubMin} onChange={e => setAllowSubMin(e.target.checked)} />
                  <span>Allow legs under 1.20 odds
                    <span className="block text-xs text-zinc-500">They don&apos;t count toward SportyBet&apos;s bonus (they don&apos;t cancel it either). Measured on live odds with the exact bonus (₦1,000 → ₦100k, greedy): allowed ≈ 0.60% chance ≥1 slip wins, off ≈ 0.64% — slightly better without them.</span>
                  </span>
                </label>
                <Field label="Seed (optional)" hint="Same seed + same odds ⇒ the same slips and the same decision log. Blank = new each build.">
                  <input type="number" min={0} placeholder="auto" value={seed} onChange={e => setSeed(e.target.value === '' ? '' : Math.max(0, Math.floor(+e.target.value)))} className={inputCls} />
                </Field>
              </div>
            )}
          </Card>
        </div>

        {/* summary / action rail */}
        <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Card title="What this builds">
            <dl className="space-y-2.5 text-sm">
              <Row k="Slips" v={slips.toLocaleString()} />
              <Row k="Stake per slip" v={naira(minStake)} />
              <Row k="Each winning slip pays" v={`≥ ${naira(target)}`} />
              <Row k="Time to place" v={`≈ ${hrs(runMin)}`} />
              <Row k="Games from" v={`${windowMin ? hrs(Number(windowMin)) : hrs(autoWindow)} from now`} />
              <Row k="Engine" v={engine === 'decision_bot' ? `Decision Bot · ${rule}` : 'Totals coverage'} />
              <Row k="Game data" v={<Badge tone="blue">history-informed</Badge>} />
            </dl>
            <Button variant="primary" size="lg" className="mt-5 w-full" loading={building} onClick={build}>
              {building ? 'Building…' : 'Build session'}
            </Button>
            {building && <p className="mt-2 text-center text-xs text-zinc-500">Fetching odds, checking team history, choosing slips…</p>}
          </Card>
          <p className="px-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            Nothing is staked here. Building only creates the slips; you place them from the session page after reviewing the numbers.
          </p>
        </div>
      </div>

      {error && <div className="mt-5"><Banner tone="error" title={error.title}>{error.detail}</Banner></div>}
      {result && <ResultCard result={result} />}
    </Page>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-3"><dt className="text-zinc-500 dark:text-zinc-400">{k}</dt><dd className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{v}</dd></div>
}

function ResultCard({ result }: { result: SessionResult }) {
  const { session, books } = result
  const b = books.find(x => x.slips) ?? books[0]
  const staked = (session.slipCount ?? 0) * session.minStake
  return (
    <Card className="mt-6" title={<span className="flex items-center gap-2">Session <span className="font-mono">{session.code}</span> is ready</span>}
      action={<LinkButton href={`/sessions/${session.code}`} variant="primary">Open session →</LinkButton>}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Slips built" value={(session.slipCount ?? 0).toLocaleString()} hint={b?.legRange ? `${b.legRange.min}–${b.legRange.max} legs each` : undefined} />
        <Stat label="Chance ≥ 1 slip wins" value={pct(b?.pAnyWin)} hint="modelled, for these exact slips" tone="accent" big />
        <Stat label="Returns per ₦100 (avg)" value={b?.keepRate != null ? `₦${Math.round(b.keepRate * 100)}` : '—'} hint="the bookmaker's price" />
        <Stat label="Expected result" value={b?.expectedNet != null ? naira(b.expectedNet) : '—'} tone={b?.expectedNet != null && b.expectedNet < 0 ? 'neg' : undefined} hint={`on ${naira(staked)} staked`} />
      </div>
      {b?.windowWarning && <div className="mt-4"><Banner tone="warn">{b.windowWarning}</Banner></div>}
      <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
        Read it plainly: about <strong>{b?.pAnyWin != null ? Math.max(1, Math.round(1 / Math.max(b.pAnyWin, 1e-4))) : '—'}</strong> sessions like this one for each session with a winning slip, and on average each ₦100 staked returns
        {' '}<strong>₦{b?.keepRate != null ? Math.round(b.keepRate * 100) : '—'}</strong>. A win pays ≥ {naira(session.targetWin)}.
      </p>
    </Card>
  )
}

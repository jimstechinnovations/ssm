# PEDLA / SSM — the full algorithm, end to end

This document explains **everything the system does from raw odds to the finished slips**, grounded in
the actual code, with worked examples and the honest maths. It is written so a newcomer (or a
researcher) can follow the whole pipeline, judge it, and see where it could be improved.

> **The one honest sentence.** The system de-vigs the bookmaker's prices, keeps the *realistic*
> correlated match-days (pruning the fantasy ones), covers the **most-probable** of them with
> full-length slips, and prices each at the boosted book odds — maximising the chance that *one* slip
> matches reality, **while every slip remains −vig**. No edge is created; we only choose which games go
> in and which Under/Over pattern each slip bets.

Core engine: [`lib/pedlas/coverage.ts`](../lib/pedlas/coverage.ts).
Selection pipeline: [`lib/pedlas/build-book.ts`](../lib/pedlas/build-book.ts).
Slip maths: [`lib/pedlas/edit.ts`](../lib/pedlas/edit.ts) · [`lib/pedlas/boost.ts`](../lib/pedlas/boost.ts).

---

## 0. The premise (what this is and is NOT)

- **It is not a predictor and creates no edge.** Goals-prediction models backtested negative on every
  market; the honest expectation of every slip is **negative** (the book's overround / vig). See
  `memory: pedlas-no-model-edge`.
- **All the algorithm chooses is structure:** which games are legs, and the Under/Over pattern per
  slip, so the *family* of slips tiles the outcomes that are actually likely. That improves the
  probability that **≥1 slip wins**, and shapes the survival curve — it never turns −EV into +EV.
- **A slip wins** iff its exact Under/Over vector equals the real results of all its legs.

---

## 1. Fetch fixtures (the raw material)

[`buildCoverageForAdapter`](../lib/pedlas/build-book.ts#L152) asks the bookmaker adapter for fixtures
inside a **selection window**: `fetchFixtures({ dateFrom, dateTo, scanLimit: 250, minKickoffGapMinutes })`.

`minKickoffGapMinutes` is critical: **no game may kick off during the placement run**, or the book
would suspend it mid-build. The window must exceed the whole run (see `estimatePlacement`,
[coverage.ts](../lib/pedlas/coverage.ts)).

## 2. Select markets + de-vig → a probability per game

[`selectAxes`](../lib/pedlas/market-select.ts) keeps fixtures with an Under-4.5 price ≥ `1.20`, then
[`devig()`](../lib/pedlas/market-select.ts#L44) converts the two-way price to **true probabilities**:

```
iU = 1/underOdds ;  iO = 1/overOdds
underProb = iU / (iU + iO)
overProb  = iO / (iU + iO)          ← the honest "cut probability" p_i
margin    = (iU + iO) − 1           ← the bookmaker's overround (the −vig)
```

Each game becomes a [`BinaryAxis`](../lib/pedlas/types.ts#L15). `overProb` is the probability the game
"cuts" an all-Under slip; it is exposed as [`cutProb()`](../lib/pedlas/coverage.ts#L23).

*Example.* Under 4.5 @ `1.10`, Over 4.5 @ `7.00` → `iU=0.909, iO=0.143` → `overProb ≈ 0.136`, and the
book's margin ≈ `0.052` (5.2% — the reason we can never be +EV on this price).

## 3. League filter + auto-extend the window

- **Exclude cutter leagues** ([here](../lib/pedlas/build-book.ts#L180)): International Club Friendlies go
  Over ~26–43% vs ~17% in real competitions, so they're dropped before selection.
- **Auto-extend** ([loop](../lib/pedlas/build-book.ts#L167)): the window grows +1 day at a time until the
  pool holds enough games that the base Under parlay × boost can reach `targetWin`
  ([`legsNeeded`](../lib/pedlas/build-book.ts#L160)). Nothing is hard-coded.

## 4. History enrichment (advisory only) + the gate

[`enrichSignals`](../lib/pedlas/build-book.ts#L197) attaches `advisory.pHat` per game = a blend of
**book × recent-form × H2H** P(Over). The `require_history` gate ([here](../lib/pedlas/build-book.ts#L206))
keeps only form-backed games when enough exist.

> **Honesty note.** History is *advisory*: it never changes the odds or the reported EV. Measurement
> (see §9) shows that weighting the build toward history *lowers* the book-honest P(win), because
> history has no edge over the book. The knob exists (`signal_weight`, default 0) only so all signals
> *can* combine if history is ever shown to beat the book.

## 5. Choose the base legs

[`chooseBaseLegs`](../lib/pedlas/coverage.ts#L357): sort games by Under odds **descending**, accumulate
the **fewest** legs whose all-Under parlay × boost ≥ `target`. Those N games are then **kickoff-sorted**
so index `i` = the i-th game to kick off ([here](../lib/pedlas/coverage.ts#L554)).

**Every slip keeps all N games** — uniform leg count, no game-dropping in the build
(`memory: uniform-full-length-slips`). A slip only ever places shorter when the *book* suspends a game
at placement time (forced; handled by place-shorter + reconcile).

## 6. The realizer — a correlated simulation that builds the slips (the core)

[`buildRealizer`](../lib/pedlas/coverage.ts#L550) plays the whole match-day thousands of times under a
**common-shock** model so that cutters move together (backtest correlation: cutter var/mean ≈ 1.7).

**Step 6a — calibrate the correlation β.**
[`calibrateBeta`](../lib/pedlas/coverage.ts#L231) bisects β until the simulated cutter var/mean ratio
matches the backtest (~1.7).

**Step 6b — preserve the marginals exactly.**
Adding correlation would drag each game's Over-rate off the book number. [`recentredIntercepts`](../lib/pedlas/coverage.ts#L155)
solves for each game's intercept `a_i` so that

```
E_z[ sigmoid(a_i + β·z) ] = overProb_i     (z ~ N(0,1))
```

i.e. the marginal Over-probability stays **exactly** the book's de-vigged number. This is what keeps the
whole thing honest under correlation.

**Step 6c — simulate & prune (the two layers).**
[The trial loop](../lib/pedlas/coverage.ts#L569): each trial draws one shock `z`; game `i` goes Over with
prob `sigmoid(a_i + β·z)`. Two "realism" layers reject fantasy days ([here](../lib/pedlas/coverage.ts#L576)):

- **Layer 1 (`maxFlipFrac`, default 0.5):** reject the day if total Overs exceed `⌊0.5·N⌋`. Base-rate
  justified (Over-4.5 days are ≤50% Over) and essentially free (see §9).
- **Layer 2 (`maxRun`, default 3):** reject a run of ≥3 consecutive-by-kickoff Overs. More arbitrary;
  kept because relaxing it changes P(win) by ~0.3% (§9) — free safety.

Every surviving (realistic) day's exact 0/1 vector is tallied in a frequency map.

**Step 6d — pick the K slips.**
[Rank](../lib/pedlas/coverage.ts#L585) by frequency (ties → higher Σ logit = the more-probable pattern),
take the all-Under base first, then the K = `budget/stake` most-frequent realistic vectors.

> **Why most-frequent is optimal.** `P(≥1 win) = Σ over chosen vectors of P(vector = reality)`. Because
> the vectors are disjoint outcomes, this sum is maximised by covering the **K most-probable** vectors —
> which is exactly what the realizer picks. No "spread it out" re-selection can beat it (it would cover
> less-probable vectors → lower P(win)). See `memory: realizer-already-optimal`.

## 7. Turn each vector into a real, priced slip

[`recomputeSlip`](../lib/pedlas/edit.ts#L30) for each chosen vector (bit 0 = Under leg, bit 1 = Over leg):

```
combinedOdds   = ∏ leg.odds
uncappedPayout = stake · combinedOdds · (1 + boost(legCount))     // boost = the book's Win-Boost table
payout         = min(uncappedPayout, maxPayout)                   // e.g. SportyBet's ₦200,000,000 cap
```

Boost table + payout maths: [`boostedPayout`](../lib/pedlas/boost.ts#L65).

## 8. Honest scoring + exposure report

- [`simulateFlipScatter`](../lib/pedlas/coverage.ts) — Monte-Carlo `P(≥1 win)` measured on **book**
  marginals (never on the history blend), so the reported chance is honest.
- [`cutRiskProfile`](../lib/pedlas/coverage.ts) — per-game survival-curve exposure: `ifOverCut`
  (slips lost if this game goes Over), `riskWeight = underSlips × overProb`, calibration gap, and
  `E[slips alive at the end]`. Surfaced as the **Cut-risk panel** on the session page. This is
  *visibility, not prevention* (see §10).

---

## Worked example — 5 games, K = 8 slips

Base (kickoff order), `overProb = [0.27, 0.20, 0.14, 0.08, 0.04]`, `maxFlipFrac = 0.5` (≤2 Overs), no
3-run. The realizer's most-frequent realistic vectors (1 = Over):

```
  #1  0 0 0 0 0   all-Under        ← most probable day
  #2  1 0 0 0 0   G1 Over          (G1 is likeliest Over, 27%)
  #3  0 1 0 0 0   G2 Over
  #4  1 1 0 0 0   G1+G2 Over
  #5  0 0 1 0 0   G3 Over
  #6  1 0 1 0 0   G1+G3 Over
  #7  0 1 1 0 0   G2+G3 Over
  #8  1 0 0 1 0   G1+G4 Over
```

What the layers did: no vector has 3+ Overs (Layer 1); `1 1 1 0 0` (a 3-run) is pruned (Layer 2).

The **marginals come out calibrated**: across the 8 slips, G1 is Over in ~4, G2 in ~3, … ≈ each game's
`overProb × K`. So when **G1 actually goes Over**, it cuts every slip that called it Under —
`(1 − 0.27)·K` of them. Scale K to 600 and that is the ~467-slip cut seen in a live session: it is the
**calibrated floor**, unavoidable and correct, not a bug.

---

## The coverage hierarchy (why "cover the first 9 games (512 slips)" is *not* used)

A recurring idea: cover all `2⁹ = 512` Under/Over combinations of the first 9 games to "guarantee alive
through 9." The system deliberately does **not** do this. For the same budget, the honest ordering is:

```
realizer (frequency-ranked, all N games considered)   ← highest P(≥1 win), best-shaped curve
   > layered ≤m-Over guarantee (considerate of the risky games)     [buildFlipScatter]
      > 512-of-9 prefix (considerate of only 9, wasteful, EV-neutral)
```

- **512-of-9** guarantees you're alive after game 9 but says nothing about games 10–N; to win you need
  *all* legs right. It also wastes most of its 512 slips on impossible high-Over prefixes (e.g. 5 of the
  first 9 Over) that Layer 1/2 would prune anyway. Net: **lower P(win)**, EV-neutral — it only makes you
  *feel* alive longer.
- **The layered design** ([`buildFlipScatter`](../lib/pedlas/coverage.ts#L441), non-default) captures the
  *useful* form: "cover **any ≤ m Overs among the E most-Over-likely games**", reported as
  `completeDepth`. Cost = `C(E,0)+…+C(E,m)`:

  | guarantee | slips |
  |---|---|
  | all 2⁹ patterns of 9 fixed games | 512 |
  | any ≤3 Overs among the 15 riskiest | 1+15+105+455 = **576** |
  | any ≤2 Overs among 20 games | 1+20+190 = **211** |

  So ~512 budget buys "any 3 of the 15 dangerous games can surprise you Over and one slip still matches"
  — a real, budget-efficient safety net, unlike 512-of-9.
- **The realizer** goes one step further: instead of a hard ≤m guarantee it covers the most-*frequent*
  correlated days, which for a fixed budget gives the highest P(win) and the smoothest curve.

**All three lose in expectation.** The only difference is how *considerately* the budget is spread — the
realizer spreads it best.

---

## The funnel & the cut (what cannot be changed)

- With K distinct full-length slips, **≤1 can match all N results** — the family funnels to ≤1 alive at
  the end. "High survival" is a curve *shape*, not a win rate.
- When game `g` resolves Over, it cuts every slip that called it Under = `(1 − overProb_g)·K`. Because
  the marginals are calibrated, this is the **minimum** possible without over-betting a low-probability
  event (which would lose far more often on the ~80% of days it stays Under).
- The worst single-game cut is bounded below by `≈ K·L/N`. To cut fewer you must **shorten slips** (drop
  games), which crashes the payout — *big payout ⇔ long slips ⇔ big cut*, the same coin. Measured
  frontier below.

---

## 9. Measured findings (real numbers, not assertions)

Probe on a realistic 35-game pool (K = 600, β ≈ 0.65). See `optimum-plan.md §11`.

**Layers are ~free; the cut is fixed:**

| config | P(≥1 win) | game-1 cut if Over |
|---|---|---|
| current (≤50% Over, no 3-run) | 47.55% | 454/600 |
| relaxed (≤70%, no 5-run) | 47.28% | 461/600 |
| wide (≤90%, no 8-run) | 47.73% | 460/600 |

**History blend lowers the honest chance** (measured on book marginals):

| `signalWeight` | P(≥1 win) |
|---|---|
| 0 (book-only) | 47.55% |
| 0.5 | 46.92% |
| 1.0 (history) | 44.92% |

**Cut vs payout frontier** (coverage mode, dropping games — *shown to justify why we keep full-length*):

| legs | dropped | median payout | P(win) | worst single-game cut |
|---|---|---|---|---|
| 35 (full) | 0 | ₦1,198 | 8.9% | 600/600 |
| 30 | 5 | ₦412 | 61% | 579 |
| 25 | 10 | ₦152 | 84% | 565 |
| 15 | 20 | ₦34 | 99% | 481 |
| 5 | 30 | ₦13 | 100% | 315 |

Reading: shortening slips raises P(win) but collapses the payout, and the worst cut barely falls until
slips are tiny. Capping the cut at (say) 50 would need ~3-leg slips (₦13 returns). Hence: **keep
full-length, accept the cut, show it in the Cut-risk panel.**

---

## 10. Honest EV & disclosures

- Every slip is **−vig**: `E[return] = trueProb · payout < stake` because `payout` embeds the book's
  overround. Structure (coverage, layers, realizer) changes *P(≥1 win)* and the curve shape, **never the
  sign of EV**.
- The boost (`(1 + boost(L))`) raises the payout but is already priced by the book; it does not create
  edge.
- The max-win **cap** can forfeit upside on the biggest vectors (`capped: true`), which only *lowers* EV.

---

## 11. Open questions (where research could genuinely help)

Improvements here would be **real** only if they clear the honest bar (measured on book marginals, no
look-ahead). Candidates:

1. **A calibrated edge vs a sharper reference.** The only honest source of +EV is a reference price
   sharper than the placing book (line shopping / closing-line value). Quantify book-vs-sharp
   disagreement on Over-4.5 and test whether it survives vig. This is the *one* avenue that could flip
   the sign of EV — everything else only reshapes an honest −EV bet.
2. **Better correlation model.** β is a single scalar fit to var/mean ≈ 1.7. Real correlation is
   league/time-clustered (a high-scoring slate lifts some competitions more than others). A structured
   copula (per-league shocks) could make the *realistic-day* set — and thus the covered vectors — more
   accurate, raising P(win) without dishonesty.
3. **Calibration audit of `overProb`.** The whole engine trusts the book's de-vigged `overProb`. A
   large-sample backtest of realised Over-4.5 vs implied, bucketed by odds/league (the §5F hypothesis in
   `optimum-plan.md`), would confirm or correct the marginal the realizer is built on.
4. **Layer 2 justification.** Layer 1 is base-rate-grounded; Layer 2 (no 3-run) is physically arbitrary
   and currently kept because it's ~free. A proper study of consecutive-by-kickoff Over runs could
   justify, tune, or remove it.
5. **Budget allocation across correlated days.** Given a fixed K, is frequency-ranking truly optimal
   once you account for *shared* legs across slips and partial-credit near-misses? (Under exact-match
   settlement it is; under any partial-payout structure it may not be.)

If you extend the engine, add your test to the same honest judge (`simulateFlipScatter` on book
marginals) and record the before/after — that's the standard the numbers in §9 were held to.

---

*Related design docs:* `optimum-plan.md` (full spec + §11 verdict), `AGENTS.md` (repo conventions).
*Related memories (private):* `realizer-already-optimal`, `uniform-full-length-slips`,
`pedlas-no-model-edge`, `pedla-cutter-backtest`.

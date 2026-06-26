# STRUCTURED PREDICTIVE MODEL
Version 1.0 — Leg-Stacking Max-Win Engine (Win Boost / Bet Saver)

> Derived from `ssm_v3.3.md`. SSM is the **structure/coverage** family (break-even floor, short
> slips, many parallel bets). **SPM is the opposite engine**: stack many legs into one slip to
> reach the maximum payout tier (up to 50 legs → 1000% Win Boost), using **Bet Saver** as the
> survival net on near-misses. Where SSM wins ~80% small, SPM wins rarely and huge.

## What SPM is

One slip, many legs, one goal: **maximise the win amount.** Payout grows two ways at once as you
add legs — the **combined odds** multiply, and the **Win Boost %** climbs the schedule (8 legs 14%
… 50 legs 1000%). SPM stacks legs the model believes are likely, then leans on a subsidy program to
survive the misses. It is Engine B from `ssm_v3.3.md §10`, promoted to its own model because making
a long slip *actually pay* requires **prediction**, not structure.

**The "Predictive" in SPM:** a 50-leg slip is impossible to hit by coverage — its probability is a
product of 50 terms. The only lever that moves it is a better **per-leg probability estimate** than
the book's. That is the model's job, and its honest limit (see §6).

---

## 1. The mechanic — payout vs probability

For N legs each with book odds `oᵢ` and true win prob `pᵢ`:

```
combined odds   O = Π oᵢ
max win (boost) = stake × O × (1 + boost(N))         (pays only on a full N/N hit)
P(full hit)     = Π pᵢ
correct legs    ~ Binomial(N, p̄)  → expected ≈ N·p̄
Bet Saver       pays a free bet when "correct legs" lands in its near-miss band
```

Two forces pull against each other:

- **More legs / higher per-leg odds → bigger max win** (O and boost both rise).
- **More legs / higher per-leg odds → lower hit probability**, and the binomial mass slides
  *down* and *widens*, so you also stop landing in the Bet Saver near-miss band.

SPM is the management of that tension.

---

## 2. The central law — leg count is set by the Bet Saver band, not by 50

Bet Saver only pays when your **correct-leg count** lands in its near-miss band (for 31 legs:
26–30/31). The binomial mode is `N·p̄`. So the slip is only *insured* when `N·p̄` sits **in or just
below the band** — otherwise you overshoot into a loss with no payout.

| Legs N | per-leg p̄ | mode N·p̄ | P(full hit) | lands in Bet Saver band? |
|---|---|---|---|---|
| 31 | 0.88 (banker) | ~27 | **1.9%** | ✅ ~82% land 26–30/31 (insured) |
| 31 | 0.80 (≥1.20)  | ~25 | 0.10% | ⚠ mode 25 — just *below* the 26 floor |
| 50 | 0.88 (banker) | ~44 | 0.17% | only if a 50-leg band reaches ~44–49 |
| 50 | 0.80 (≥1.20)  | ~40 | **0.0014%** | ❌ mode 40 — far below any near-miss band |

**Reading it:** the 31-leg Bet Saver program is *calibrated* so that a slip of strong bankers
(p ≈ 0.88) lands in its near-miss band ~82% of the time. Push to 50 legs and the mode falls to ~40
— you neither hit nor near-miss, you just lose, and Bet Saver never triggers. **So the model must
derive N from p̄ to put `N·p̄` in the band — it does not blindly stack to 50.**

> **Eligibility note that matters here:** Win Boost needs legs ≥ 1.20. **Bet Saver does not.** So a
> Bet-Saver slip can (and should) use sub-1.20 **bankers** (p ≈ 0.85–0.90) to lift the binomial
> mode into the insured band. The ≥1.20 rule only constrains the boost path.

---

## 3. The two operating modes

### Mode S — Survival (Bet Saver banker slip)
~31 legs of high-probability bankers (p ≈ 0.88, odds ~1.10), **Bet Saver, no boost.**
- Lands in the near-miss band ~82% of sessions → frequent free-bet recoveries.
- Full 31/31 hit ~1.9% → a modest jackpot (e.g. `1.10³¹ ≈ 19× → ₦19,000 on ₦1,000`).
- This is the *survivable* version: you almost always get *something* back; you occasionally cash a ~19×.

### Mode M — Max win (1000% boost lottery)
Up to 50 legs at the ≥1.20 floor (odds ~1.20), **Win Boost 1000%, no Bet Saver.**
- Max win `= ₦100 × 1.20⁵⁰ × 11 ≈ ₦100 × 9,136 × 11 ≈ ₦10.05 million` on a ₦100 stake.
- P(full hit) ≈ **0.0014%** (~1 in 70,000). Mode is ~40/50 → almost always a clean loss.
- No insurance (Bet Saver off; mode far below any band). **Pure lottery ticket.**

The user's stated target ("stack to 50 legs, high odds, hit max") is **Mode M**. It is the maximum
payout *and* the maximum variance — a ₦10M moonshot at a ~1-in-70,000 strike rate.

**Measured — where Bet Saver's band actually catches the binomial** (`binomialBand`):

```
N   per-leg p   band     expected correct   P(in band)   P(full hit)
31    0.88      26–30        27.3             82.0%        1.90%     ← Mode S sweet spot
31    0.80      26–30        24.8             39.2%        0.10%
50    0.88      45–49        44.0             43.4%        0.17%
50    0.79      45–49        39.5              3.4%        0.0008%   ← overshoots: saver useless
```

Mode S lives at ~31 legs *with bankers* (p ≈ 0.88) — 82% of sessions land in the insured band. Push
to 50 legs at typical p and the mode falls below any near-miss band (3.4%): Bet Saver barely fires,
so a 50-leg slip must take **Win Boost (Mode M)**, not Bet Saver. (Bet Saver has no ≥1.20 rule, so
Mode S *should* use sub-1.20 bankers to lift the mode into the band.)

---

## 4. Worked numbers — the honest EV at the extremes

EV multiple `= (p̄ · ō)ᴺ × (1 + boost)`, where `p̄·ō = 1 − margin` per leg.

| Slip | margin | boost | (1−m)ᴺ | × (1+boost) | EV |
|---|---|---|---|---|---|
| Mode M: 50 legs @1.20 | 6% | 1000% | 0.94⁵⁰ = 0.045 | × 11 | **−50%** |
| Mode M: 50 legs @1.20 | 3% | 1000% | 0.97⁵⁰ = 0.218 | × 11 | **+140%** |
| Mode S: 31 legs banker | 5% | (Bet Saver) | 0.95³¹ = 0.20 | + insurance | ~**−65%** before saver, ~−55% after |

Two honest readings:
- At **normal margins (6%) even the 1000% boost leaves Mode M at −50%** — the jackpot is real but
  you bleed half your stake in expectation.
- At **genuinely low margins (~3%)** the 50-leg / 1000% tier flips **positive (+140%)**. That is the
  *only* way SPM is +EV — and it requires sourcing ~3%-margin legs, i.e. a real pricing edge, not
  structure. This is the same conclusion as `ssm_v3.3.md §3`: the boost is a calibrated rebate;
  beating it needs mispriced legs.

---

## 5. The ₦50M cap, min-stake leverage & the ticket book

**The cap.** Betway caps the max win (≈ **₦50,000,000**). Win = `stake × O × (1+boost)`, so:

- **Use the minimum stake (₦100).** A smaller stake needs *higher* odds to reach the cap → more
  boost leverage per naira. `₦100 → ₦50M` needs `O × (1+boost) ≈ 500,000`; at 1000% boost (×11)
  that's `O ≈ 45,000` → ~50 legs at avg odds **~1.24** (`₦100 × 1.24⁵⁰ × 11 ≈ ₦50M`).
- **Don't overshoot the cap.** Odds beyond `cap / (stake × (1+boost))` are **forfeited** — you pay
  for them (lower hit probability) but aren't paid for them. The model must cap combined odds at the
  payout ceiling; a ₦77M-theoretical slip against a ₦50M cap is pure EV leakage.

**The ticket book — outcome-variation coverage.** Bankroll ÷ min stake = shots
(`₦1,000 / ₦100 = 10`). There are **exactly 50 distinct matches**, and **all 10 slips use those same
50 matches** (one leg per match → the 50-leg / 1000% tier). The slips differ only by **proposing a
different outcome for the riskiest matches** — a base slip plus single-deviation variations (the SSM
coverage idea, at 50 legs). When a leg's primary outcome looks unachievable, another slip carries an
alternative outcome on that same match → a second shot. **It is not a 500-match pool; it is 50
matches re-bet with varied outcomes.**

> **Hard rule — one match per slip.** No slip may contain two legs from the same fixture. So a
> match's alternative outcome always lives in a *different* slip, never alongside its primary.

- **Measured:** base `P = 1/675,769`; the 10-slip book `P(any) = 1/145,212` — a **4.7× lift**.
- The lift is **inherently sub-linear** (never 10×): all 10 slips share the same 50 matches, so they
  overlap on 40+ legs and differ only on the few swapped outcomes — highly correlated, not
  independent tickets. The gain comes purely from covering alternative outcomes on the uncertain
  matches. **EV of the book = 10 × one ticket** — buying shots never changes the sign; it widens the
  net. Still a lottery, by design.

**EV of the book = 10 × the EV of one ticket** — buying more tickets never changes the sign. So the
whole question is whether *one* 50-leg slip is +EV.

**The margin crossover (the thing that actually decides it).** EV multiple `= (1−m)⁵⁰ × 11`:

```
(1−m)⁵⁰ × 11 = 1   →   m* = 1 − 11^(−1/50) ≈ 4.7% per-leg margin
```

| per-leg margin | EV multiple (×11 boost) | verdict |
|---|---|---|
| 3% | 0.97⁵⁰ × 11 = **2.40** | +140% — strongly +EV |
| 4% | 0.96⁵⁰ × 11 = **1.43** | +43% — +EV |
| **4.7%** | **≈ 1.00** | break-even |
| 5% | 0.95⁵⁰ × 11 = **0.85** | −15% |
| 6% | 0.94⁵⁰ × 11 = **0.50** | −50% |

So the ₦100→₦50M lottery is **genuinely +EV if and only if you can fill 50 legs at ≥1.20 with
per-leg margin below ~4.7%.** The 1000% boost is large enough to flip the sign — Betway's defence is
the ≥1.20 floor (no near-lock farming) plus pricing most eligible markets *above* 4.7%. **The entire
SPM edge reduces to one task: sourcing 50 low-margin (<4.7%), ≥1.20 legs** (§6's job); a predictive
`p̂ > p_book` only sweetens it. This is the closest thing to a real edge in the whole project — and
it's a knife-edge on margin, not a free lunch.

**Measured (scanner `lib/spm/leg-stacker.ts`).** The precise break-even is
`m* = (1+boost)^(1/N) − 1` (the two-way overround form; the `1 − 11^(−1/50) ≈ 4.7%` above is the
subtractive approximation). It **rises with the boost tier**:

```
legs   boost   break-even per-leg margin
  8     14%     1.65%
 31    180%     3.38%
 50   1000%     4.91%
```

Counter-intuitively, **the 50-leg / 1000% tier is the *most* margin-forgiving** — the boost grows
super-linearly at the top, so going long is *correct* for the boost play (the opposite of SSM's
coverage engine, where short = less vig). The scanner then decides any real pool — selecting the 50
lowest-margin ≥1.20 legs and reporting the verdict:

```
pool     avgMargin  combOdds   maxWin    P(hit)        EV/₦1   verdict
SHARP    3.83%       31,205×   ₦34.3M    1/204,173     1.68    ✅ +EV (+68%)
JUICED   6.77%      110,013×   ₦50.0M*   1/2,907,582   0.17    ❌ −EV (−83%)
                                  (* odds overshoot the ₦50M cap → forfeited odds)
```

Same strategy, opposite verdict — purely from leg-margin quality. SHARP clears 4.91% → the ₦100
shot is genuinely +EV (still ~1-in-200k: the +EV lives entirely in the rare ₦34M hit). JUICED is
both above the margin line *and* overshoots the cap (wasted odds). **This is the clean,
not-blind decision:** measure every leg's real margin, and take the all-or-nothing shot only when
the pool clears the line.

---

## 6. The SPM algorithm (derived, honest)

1. **Predict per-leg probabilities** `p̂ᵢ` for a candidate pool (the model's core — §6).
2. **Pick the program:**
   - Want survival + frequent returns → **Mode S** (Bet Saver, ~31 bankers).
   - Want the max jackpot, accept the lottery → **Mode M** (Win Boost 1000%, up to 50 legs ≥1.20).
3. **Derive N** so the binomial mode `N·p̄` lands in/above the chosen program's band
   (Mode S: `N·p̄ ≥ 26` for the 31-leg band; Mode M: maximise `O × (1+boost)` subject to a minimum
   acceptable `P(full hit)`).
4. **Select the N highest-`p̂` legs** that satisfy the program's eligibility (Mode M: odds ≥ 1.20;
   Mode S: any, prefer bankers).
5. **Single stake** (no Dutching — it's one slip). Size by bankroll-survival, not by break-even.
6. **Report** P(full hit), expected correct legs, P(in band), max win, and EV — never hide them.

---

## 7. The predictive core — the only real lever (and its limit)

Stacking legs cannot create probability; only a **better estimate of `pᵢ` than the book's** can move
`P(full hit)` and the binomial mode. So SPM lives or dies on prediction quality:

- **Odds-derived `p̂` = the book's view** → SPM sits exactly at `−margin` (Mode M −50%). No edge.
- **An independent signal** (xG, league-specific co-resolution rates from `ssm_v3.3.md §6`, team
  news) that makes `p̂ᵢ > p_book` on some legs → raises the realised mode, pushes Mode M toward the
  +140% region, and makes Mode S land in-band more often. **This is the entire value of the "P" in SPM.**
- **Honest limit:** without that signal, SPM is a subsidised lottery. The prediction module must be
  built and validated as a statistical estimator with confidence intervals — not assumed.

---

## 8. Relationship to SSM — the full portfolio

| | SSM v3.3 (Engine A) | SPM v1 (Engine B) |
|---|---|---|
| Goal | break-even floor, high win rate | maximum win amount |
| Slips | many short (4–5 legs), Dutch-staked | one long (31–50 legs), single stake |
| Subsidy | Win Boost (≥1.20 coverage legs) | Bet Saver (Mode S) **or** 1000% Boost (Mode M) |
| Win rate | ~80% | 1.9% (Mode S) / 0.0014% (Mode M) |
| Variance | low | extreme |
| Needs prediction? | no (structure) | **yes (its whole point)** |

**Portfolio:** run SSM Engine A as the floor, allocate a minority of bankroll to SPM for the
upside, and recycle SPM/Bet-Saver free bets back into SSM's boosted legs (`ssm_v3.3.md §10`).

## 9. Honest position

Stacking odds alone does not beat the book — but the **1000% boost is a knife-edge** (§5): the
50-leg tier is +EV when per-leg margin is below ~4.7%, and −50% at 6%. So SPM is **not necessarily
−EV**; its value is getting onto the right side of that ~4.7% crossover by **sourcing low-margin,
≥1.20 legs** (and, where possible, legs where `p̂ > p_book`). Absent that, it is a
**deliberately fat-tailed, subsidy-softened lottery**, with Bet Saver buying survival when N is kept
near the insured band. **Maximum win, maximum variance — and a genuine but margin-fragile edge.**

## 10. Implementation sketch (when we build)

Reuse the SSM primitives: `fingerprint.ts` / `scoreline-model.ts` for per-game market resolution.

**Built (`lib/spm/leg-stacker.ts` + `__tests__/lib/spm/leg-stacker.test.ts`, passing):**
- `legFrom(pair)` — measure a leg's real two-way margin and de-vigged `pBook` from paired odds.
- `selectLegs(pairs, {count, minOdds})` — clean selection: eligible ≥1.20, lowest-margin first.
- `planSlip(legs, {stake, cap})` → `{combinedOdds, boost, pHit, maxWin (capped), evMultiple, evWithCap}`.
- `boostFor(N)` / `breakEvenMargin(N)` — the full schedule and the `(1+boost)^(1/N)−1` crossover.

**Built — Mode S, ticket book & the one-match rule (`__tests__/lib/spm/ticket-book.test.ts`, passing):**
- `hasDuplicateMatch(legs)` — enforces the one-match-per-slip rule.
- `groupByMatch` / `selectBaseSlip` — match-unique selection (one outcome per match).
- `buildTicketBook(matches, {legCount, shots})` — base + single-deviation variations; `P(any hit)`.
- `binomialBand(N, p)` / `betSaverBand(N)` / `chooseLegCount(p, mode)` — Mode S band targeting.

**Still to build (the only +EV lever):**
- `predictLegProb(signal)` — an independent edge signal; the sole path past `p̂ = p_book`.

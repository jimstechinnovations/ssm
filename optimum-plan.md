# optimum-plan.md — the honest "one-entering" engine + a two-session learning loop

**Status:** design/spec (discuss before building). No edge is claimed anywhere in here; every slip
is still −vig. This plan makes the slip-scatter *optimal at its own objective* (maximise the chance
that ≥1 slip's exact U/O vector matches the day) and sets up a disciplined way to learn from real
results. See also `pedlas_v3.md`, and the memories: *pedlas-no-model-edge*, *pedlas-cutter-backtest*.

---

## 0. The objective, stated exactly

We place **K** slips (K = budget ÷ stake, e.g. 500). Each slip is a distinct exact outcome vector
over the **N** legs (a bit per game: Under=0, Over=1). A slip wins **iff its whole vector equals the
realised day**. Because the vectors are distinct, the slips are **disjoint events**, so

```
P(≥1 slip wins) = Σ_k P(vector_k occurs)
```

To maximise that sum with K tickets you must cover the **K most-probable outcome vectors** — this is
just "greedy on disjoint events," and it is provably optimal. Everything below is about estimating
`P(vector)` as truthfully as possible and then covering the top K.

**Honest ceiling (measured this build):** with N≈35, correlated ~19% Over rate, the best reachable
value is ~**0.3–0.7%**. No arrangement beats that materially; the target is a needle. This plan gets
us to the top of that range and no further — it does not create EV.

---

## 1. What the current engine does (and its three self-inconsistencies)

`buildFlipScatter` ranks patterns by `Σ logit(P Over)` over flipped legs (flip the least-confident
Unders first) and covers outward from the all-Under base. That skeleton is correct. Three cracks:

1. **Ranks/allocates under INDEPENDENCE, judged under CORRELATION.** The per-depth slot allocation
   uses a Poisson-binomial pmf of `#Overs` assuming independent games, but `simulateFlipScatter`
   (the judge) uses a common-shock correlated model (β calibrated to var/mean≈1.7). The builder and
   the judge disagree about the distribution.
2. **The ranking probability is polluted.** `overLikelihood = 0.55·book + 0.30·form + 0.15·H2H`.
   The sharpest estimate of `P(Over)` is the book's **de-vigged price alone**; form/H2H don't beat
   the book, so blending them into the *ranking* adds noise and can mis-order patterns. (They are
   still fine for the *selection gate* — that's a different job.)
3. **The scatter constraints delete probable patterns.** `max_flip_frac` (≤50% Over) and `max_run`
   (no 3 consecutive Overs) prune the candidate set; some pruned patterns are more probable than the
   deeper ones kept. This is *why* scatter measured lower P(win) — it encodes an unvalidated prior.

---

## 2. The optimum plan (three changes)

### Change A — rank by book-only de-vigged probability
Use `p_i = axis.overProb` (already de-vigged, sums to 1 within the axis) as the ONLY per-game Over
probability for pattern ranking.

- Keep `enrichSignals` (form + H2H) for the **selection gate** (which games are even eligible) — no
  change there.
- In `overLikelihoodForRanking(a)` return `clamp(a.overProb)` — *not* the blended advisory.pHat.
- Rationale (worked): a vector's log-probability under independence is
  `log P(v) = Σ_{i∈flipped} log p_i + Σ_{i∉flipped} log(1−p_i)`. For a fixed flip-count this ranks by
  `Σ_{flipped} logit(p_i)`. Using the best-calibrated `p_i` (the price) makes this ordering track the
  true likelihood most closely. Any noisier `p_i` strictly degrades the ordering in expectation.

### Change B — allocate & rank with the CORRELATED model, not independence
Replace the independent Poisson-binomial allocation with an empirical distribution from the same
common-shock model the judge uses.

- Draw `T` (e.g. 20k) correlated samples: `z~N(0,1)`, game i is Over w.p. `sigmoid(a_i + β·z)` with
  `a_i` re-centred so the marginal is exactly `p_i` (we already have `recentredIntercepts` + `β` from
  `calibrateBeta`).
- Two ways to consume the samples (pick one; B2 is cleaner):
  - **B1 (allocation):** histogram the sampled `#Overs` → depth weights `w_d` (replaces the pmf), then
    fill each depth with its top-`Σlogit` patterns as today.
  - **B2 (direct, preferred):** count how often each *exact vector* appears across the T samples;
    cover the **K most-frequent sampled vectors**. This is a Monte-Carlo estimate of "the K most-
    probable vectors" under the *true correlated law* — no depth bookkeeping, no independence, and it
    automatically captures "many games move together" days. Break ties / extend coverage with the
    `Σlogit` order for vectors that didn't appear in the sample.
- Cost: one extra correlated MC pass at build (cheap; we already run 3k trials to report P(win)).

### Change C — make the run / ≤50% constraints an explicit shape TOGGLE, off by default
For the **max-P(win)** build, drop `max_run` and `max_flip_frac` entirely (cover the true top-K).
Keep them available as an opt-in "I want a scattered, bigger-jackpot shape" mode — clearly labelled
as a *variance choice that costs hit-chance*, which the A/B (below) will quantify every time.

---

## 3. Implementation sketch (small, contained)

- `lib/pedlas/coverage.ts`
  - add `overLikelihoodForRanking(a) = clamp(a.overProb)` (book-only); keep `overLikelihood` for any
    display, but use the new one for pattern ranking.
  - add `topVectorsCorrelated(pool, K, {β, trials})` implementing **B2**: sample → tally exact
    vectors → return the K most-frequent, `Σlogit`-extended. Reuse `recentredIntercepts`, `gaussian`,
    `mulberry32`.
  - `buildFlipScatter`: new `mode: 'optimum' | 'scatter'` (default `optimum`). `optimum` calls
    `topVectorsCorrelated`; `scatter` keeps today's constrained path.
- `lib/pedlas/build-book.ts` / `app/api/sessions/route.ts`: thread a `mode` (or reuse absence of
  `max_flip_frac` ⇒ optimum). No schema break.
- Tests (`coverage-engine.test.ts`): optimum build (i) covers the all-Under base, (ii) covers the K
  most-frequent correlated vectors (assert against a fixed-seed sample), (iii) `simulateFlipScatter`
  P(win)_optimum ≥ P(win)_scatter on the same pool.

---

## 4. The A/B — prove the delta honestly

For every real pool, before placing, build **both** and report side by side using the *same*
correlated judge (`simulateFlipScatter`, fixed β/seed):

| build            | P(≥1 win) | median payout | max flip | note                     |
|------------------|-----------|---------------|----------|--------------------------|
| optimum (A+B+C)  |   …%      |   ₦…          |   …      | book-ranked, correlated  |
| current layered  |   …%      |   ₦…          |   0–2    | independent pmf          |
| scatter-50       |   …%      |   ₦…          |   0–…    | shape/variance choice    |

Success = optimum's P(win) ≥ every other build on the same pool (it should, by construction). If it
*isn't*, the correlated sampler or the re-centring has a bug — that's a real signal, not a wash.

---

## 5. The two-session learning loop (the part we do next)

We already persist per-game outcomes (`/settle` → `meta.gameResults`, FT total + Over/Under) and slip
verdicts (early-cut). Take **two independent placed sessions**, pull their realised results, and mine
them for structure. Concretely, per session compute and store a small `learnings` record:

**A. Calibration of the price.** For every game, bucket by book `P(Over)` (e.g. 0–10%, 10–20%, …) and
compare to the realised Over rate. Is the book's de-vigged `P(Over)` well-calibrated, biased high, or
biased low on *our* selected pool? (If it's biased, that's the first thing that could become an edge.)

**B. Realised correlation.** Count `#Overs` per session and compare its spread to the marginal sum.
Is var/mean really ≈1.7 on live days? Re-estimate β from actual results across the two sessions →
feed a better β back into `calibrateBeta`'s target. Also: did the Overs *cluster* (by league? by
kickoff window? by both teams' form?) — test whether the "no-3-run" prior has ANY support.

**C. Did form / H2H predict anything?** For the games where we had form (λ) and/or H2H, correlate the
signal with the realised Over/Under. If form has *zero* incremental predictive value over the price
(likely), Change A is vindicated and we stop pretending otherwise. If it has a little, quantify it.

**D. Where did slips die?** Across both sessions, which specific games were the "cutters" that killed
the most slips, and were they the ones our ranking thought were safe? Mis-ranked cutters = ranking
error we can measure and fix.

**E. Would optimum have done better?** Re-run the optimum builder on each session's *original pool*
and check whether its covered vectors were closer to the realised vector than what we actually placed
(Hamming distance to the realised day; did any optimum vector match more legs?).

**F. The "Under 4.5 @ ≥1.2" calibration hypothesis (operator-noticed signal).** Games the book prices
Under 4.5 at odds ≥ 1.2 imply de-vigged `P(Over 4.5) ≳ 15–18%` — "goals-prone, not a lock." As stated
this is just the price (and it's already our flip-eligible line), so it carries **no edge by itself**.
It becomes real *only* if the book is mis-calibrated on it. Test, across sessions: bucket every game
by its book Under-4.5 odds (`[1.0–1.1), [1.1–1.2), [1.2–1.35), [1.35+)`) and compare **realised Over
4.5 rate** to the **implied** rate per bucket.
- realised Over rate **< implied** in the ≥1.2 buckets ⇒ Under 4.5 is *underpriced* there ⇒ value on
  our side; tighten the base parlay onto exactly these.
- realised Over rate **> implied** ⇒ the Over is the value and our Under parlays are worse than
  modelled; the ≥1.2 games should be *dropped from the base*, not just flip-eligible.
Also record, for these games, the realised rate of Over 1.5 / Over 2.5 (sanity: should be near the
priced near-certainty — if the book is loose on the *low* lines too, that's a second, cleaner signal).
Needs volume: log the buckets every session; a 2-session read is directional only, not significant.

Output: append findings to this file (a dated `## Learnings` section) and turn any real, repeated
signal into a concrete change for the next session. Two sessions is not significance — it's the start
of a log. The discipline is: **every session's realised result updates β, the calibration check, and
the form/H2H verdict; nothing gets "improved" on a hunch.**

---

## 6. Honest success criteria

- Engineering win: optimum ≥ all other builds on P(win), reproducibly; the builder and judge finally
  agree on the distribution.
- Reality check unchanged: P(win) stays ~0.3–0.7%; EV stays `stake·(1−margin) < 0`. This plan makes
  the lottery *optimally played*, not winnable.
- The only path to +EV remains a **sharp-book reference** (place only when a sharper book's de-vigged
  price beats SportyBet's by more than the margin). The learning loop (§5A calibration) is how we'd
  first *detect* whether such a gap exists on our pool — so this plan is also the on-ramp to that.

# SCORE STRUCTURE MODEL
Version 3.2 — Optimised Probability Coverage (retires the brute-force 56-slip matrix)

## What is new in Version 3.2

v3.1 hand-builds **56 slips** (30 CORE + 8 PIVOT + 14 BRIDGE + 4 CHAOS) by enumerating
flip-patterns and ranking them with a *volatility proxy*. v3.2 keeps the original goal —
**cover the 2⁸ = 256 binary outcome space of an 8-game session** — but replaces the
hand-built matrix with a **computed optimal cover**:

1. **True binary axis.** Force every game onto **total goals (Over/Under)** — a genuine
   complement — instead of letting the profiler pick whatever market is shortest-priced.
2. **Probability-ranked coverage.** Enumerate all 256 vectors, rank by *true* probability,
   and cover the most-probable sessions first.
3. **Dutch staking.** Stake each covered vector so **every covered session returns the same
   amount**, set to a chosen break-even / profit target.
4. **One control instead of four tiers.** A single `costTarget` dial trades **win rate vs
   margin-on-win**. No CORE/PIVOT/BRIDGE/CHAOS, no duplicates, no phantom slips.

This is a drop-in evolution of v3 (same 8-game, same 256 space), not the v4 redesign.

---

## 1. Why the 56-slip matrix had to go (measured)

The fingerprint scorer (`lib/ssm/slip-analysis.ts`) was run against the actual
`generateMatrix` output on a realistic 8-game set. Findings:

- **8 of 56 slips are exact duplicates.** PIVOT 31–38 encode the *identical* bet to CORE 2–9
  (`generateCoreSlips` already emits all 8 single-flips). The "N-1 error-correcting" tier is
  CORE re-staked — zero new coverage.
- **6 of 8 games were profiled onto a phantom axis.** `selectDominantOutcome` picks the
  highest-implied-probability binary, which self-selects **DC 12 / DC 1X** — markets that
  *overlap* (both resolve on a home win). Average state overlap **0.33** (a true complement is
  0.00). Flipping those games barely changes the bet.
- **The "56 slips" are nowhere near 56 distinct bets.** Win probabilities compressed into
  3.4%–13%, because short DC odds made most flip-vectors near-identical near-locks.
- **EV is flat at ≈ 0.68 (−32%) across every tier** — CORE, PIVOT, BRIDGE, CHAOS all priced
  the same. Tiering buys nothing.
- **≥ 10 of 56 slips removable** by the crudest test (8 dupes + 2 sub-0.5%).

### Before / after forcing the true (total-goals) axis

```
                          v3 profiler   total-goals axis
avg state overlap              0.333         0.000     ← phantom flips eliminated
phantom-flip games /8              6             0
exact dupes (PIVOT)                8             8     ← structural, axis-independent
win-prob max                  13.14%         1.82%     ← DC short odds were hiding it
live slips (>1%) /56              53            32
dead-weight (<0.5%)                2             9
EV range                   0.67-0.68     0.67-0.68     ← unchanged (it is the vig)
```

The axis fix removes the phantoms but **exposes** that 8 coin-flip legs make most flip-vectors
genuinely rare — i.e. brute-forcing 56 vectors is the wrong tool. The right tool is to cover
the **high-probability** vectors deliberately and stake them to a target. That is v3.2.

---

## 2. The model

For N games (default 8) on the total-goals axis, each game *i* has two states with **true**
probabilities `p_i0, p_i1` (`p_i0 + p_i1 = 1`) and **book odds** `O_i0, O_i1`.

A session is one of the `2^N` vectors `v`; exactly one occurs. For each vector:

```
trueProb  P(v) = ∏ p_i(v_i)
odds      O(v) = ∏ O_i(v_i)
bookcost  1/O(v)          (the book-implied probability of v)
```

**Coverage selection.** Sort all vectors by `P(v)` descending; add them (modal session first,
then 1-flips, 2-flips …) until cumulative book cost `c(S) = Σ_{v∈S} 1/O(v)` reaches `costTarget`.

**Dutch staking.** Stake `s(v) = B / (c(S) · O(v))`. Then **every** covered vector returns the
same `T = B / c(S)`, and total stake is exactly `B`.

```
win rate       = Σ_{v∈S} P(v)
return-if-hit  = B / c(S)        (identical for the modal hit and the longest-shot hit)
costTarget 1.0 ⇒ break-even on every win;  < 1.0 ⇒ profit on every win (lower win rate)
```

---

## 3. The single dial — win rate vs break-even (measured, B = ₦10,000, 8 games)

```
costTgt  slips  winRate  return/hit  net/hit     EV       affordable (≥₦100)
 0.70     43     47.4%    ₦14,330     +43%     ₦6,788        43/43
 0.85     57     57.4%    ₦11,820     +18%     ₦6,789        57/57
 1.00     79     67.6%    ₦10,040      +0%     ₦6,788        54/79
 1.20    124     81.3%     ₦8,341     -17%     ₦6,785        43/124
 1.40    189     94.9%     ₦7,147     -29%     ₦6,783        29/189
```

- Want **profit when you win**? Cover less (0.70): 47% win rate, **+43%** on every win.
- Want **high win rate that never loses on a win**? Cover to break-even (1.00).
- Want to **almost never lose everything**? Cover 1.40: 95% win rate, but −29% on every win
  (you are just paying the vig slowly).

### The recommended build — "high win rate with good break-even in worst case"

**`costTarget ≈ 1.0`:**

- **79 slips, 67.6% win rate.**
- **Every covered session returns ₦10,040** — the modal 0-flip hit and a 5-flip outsider hit
  pay *identically*. No dead small wins; the worst covered case *is* break-even.
- Only the **uncovered 32.4%** of sessions lose the bankroll.

Dutch spread (sample): `0 flips, odds 37×, stake ₦269` … `5 flips, odds 108×, stake ₦93` —
all returning ₦10,040.

---

## 4. Honest mathematical position — EV is constant and cannot be rearranged away

For proportional book margin, every vector satisfies `1/O(v) = P(v) · R`, where
`R = overround = ∏(1 + marginᵢ)` is the **same** for all vectors. For any covered set `S` and
any stakes summing to `B`:

```
EV = Σ P(v)·s(v)·O(v) = Σ [(1/O(v))/R]·s(v)·O(v) = (1/R)·Σ s(v) = B / R
```

`O(v)` cancels — EV depends only on stake and overround, **not** on which vectors you cover or
how you split stakes. Sample: `R ≈ 1.05⁸ = 1.477`, so `EV = 10,000 / 1.477 ≈ ₦6,770 ≈ ₦6,788`.
That is why every row above prints ₦6,788.

**Consequences (the only levers):**

- **Break-even ceiling = 1/R.** For 8 legs at 5% margin that is **67.7%** — the maximum win
  rate at which winning never loses money. v3.2 hits it (67.6%).
- **To raise the ceiling, shorten the pool.** 4 legs → `R = 1.05⁴ = 1.216` → ceiling **≈ 82%**.
  Fewer legs is the only structural way to improve the trade.
- **To beat EV you need a real edge** — true probabilities *different from* the book's
  de-vigged prices. Odds-derived probabilities set `P = P_book` by construction, pinning EV at
  `B/R`. v3.2 is **risk-shaping, not profit**. The downside is *not* a small bounded floor: it
  is a `1 − winRate` chance of full-bankroll loss (at target 1.0, a 32.4% chance).

---

## 5. Implementation

Pure, tested modules already prototyped in `lib/ssm/`:

- `fingerprint.ts` — `resolveMarket(market, scoreline)`, `fingerprint(scoreline)`, label map.
- `scoreline-model.ts` — per-game scoreline distribution (independent Poisson; swap for
  Dixon-Coles), `pMarket(dist, market)`.
- `slip-analysis.ts` — `slipWinProb`, `findDuplicateGroups`, `scoreMatrix` (the v3 audit tool).
- `coverage-optimizer.ts` — `enumerateVectors`, `optimizeCoverage({ bankroll, costTarget })`
  → `{ slips, winRate, returnPerHit, costOfCoverage, expectedValue, belowMinStake }`.

Executable evidence: `__tests__/lib/ssm/slip-analysis.test.ts` (5 passing reports — duplicates,
phantom axis, before/after, optimized dial).

**To productionise (replace `generateMatrix`):**
1. Profiler → force the total-goals axis (fix `gate-screener.ts → selectDominantOutcome`).
2. Build per-game `GameAxis` from live odds + a scoreline model.
3. `optimizeCoverage` with a UI `costTarget` control (default 1.0).
4. Handle the **₦100 floor**: at target 1.0 only 54/79 slips clear ₦100 — either raise
   bankroll, trim the high-odds tail, or merge. Make `stake-calculator.ts` / `distributor.ts`
   count-agnostic (the v3.1 30/8/14/4 hardcodes go away).

## 6. Operating notes

- **Pool size N** drives the ceiling — prefer 4–6 over 8 (higher break-even win rate, less vig).
- **`costTarget`** is the only risk knob: 1.0 = break-even/max-win-rate; < 1.0 = profit cushion,
  lower win rate; > 1.0 = high win rate, guaranteed margin loss on wins.
- **Re-fit per session** from live odds. Track ≥ 10 sessions before judging variance.
- Optimised coverage. Dutch-staked. Break-even worst-covered-case. **Not** an edge over the book.

# SCORE STRUCTURE MODEL
Version 3.3 — Boost & Subsidy Mechanics (Win Boost + Bet Saver, on top of v3.2 coverage)

## What is new in Version 3.3

v3.2 produced **optimised probability coverage** of the binary session space (true axis,
probability-ranked vectors, Dutch staking) and proved EV = `B/R` is fixed. v3.3 adds the
**bookmaker subsidy layer** — Betway's **Win Boost** and **Bet Saver** — and shows how to
capture it without making false predictive claims. Key results, all derived from a real slip:

1. **The ≥1.20 eligibility rule.** Legs priced below 1.20 earn **zero** boost and don't advance
   the leg-tier — they only add compounded margin. Never spend a slot on one.
2. **Boost is a ~4-point rebate, not a leak.** At normal margins it never catches the compound
   vig; the ≥1.20 floor exists specifically to stop boost-farming with near-certain legs.
3. **Bet Saver reshapes the tail.** It insures the dense "near-miss" band (far more likely than
   the win), lifting EV a few points — shape, not magnitude.
4. **Boost-eligible markets ARE the coverage markets.** Odd/Even, BTTS Yes/No, Over/Under 2.5
   are all naturally ≥1.20, true binaries, and fingerprint-co-resolving — a three-way alignment.

This is a mechanics layer; the coverage engine remains v3.2 (`coverage-optimizer.ts`).

---

## 1. The decode — a real 7-leg slip proves the ≥1.20 rule

| Leg | Odds | Boost-eligible (≥1.20)? |
|---|---|---|
| Viljandi JK Tulevik | 1.56 | ✅ |
| Union Espanola | 1.35 | ✅ |
| FK Babrungas | 1.98 | ✅ |
| FK Garliava | 1.28 | ✅ |
| **Over 0.5 Dalian** | **1.10** | ❌ |
| **Kedainiai Nevezis** | **1.14** | ❌ |
| FK Panevezys B | 1.80 | ✅ |

- Total odds = `1.56·1.35·1.98·1.28·1.10·1.14·1.80` = **12.048**
- Slip displayed "Win Boost **8%**, 1 more for 10%" → 8% = **5 legs** (table), not 7.
- Only the **5 legs ≥ 1.20** qualify. Eligible-leg odds = `1.56·1.35·1.98·1.28·1.80` = **9.6075**.
- Boost paid = `8% × ₦1,000 × 9.6075` = **₦768.6** → matches displayed **₦768.59**.
- Total win = `₦1,000 × 12.048 + ₦768.59` = **₦12,816.59** → matches **₦12,816.28**.

**Conclusion:** stake was ₦1,000, and the two sub-1.20 "bankers" (1.10, 1.14) did three harmful
things at once — (a) didn't count toward the leg-tier (stuck at 8% not higher), (b) earned **₦0**
boost, (c) still multiplied odds, i.e. added compounded margin. They are pure boost dilution.

> **Rule 1 — never place a sub-1.20 leg.** If the thesis is "this game has a goal," don't take
> Over 0.5 @1.10; take a co-resolving Over 1.5 @1.30 or a binary @≥1.20 from the same game. Same
> real-world outcome, now eligible and tier-advancing. The fingerprint finds the substitution.

---

## 2. Boost-eligible binary markets (the markets the model should prefer)

The natural-language binaries used by the fingerprint coverage are almost all ≥ 1.20 — so they
qualify for the boost *and* form clean complements *and* co-resolve. The short "banker" markets
that are boost-dead are exactly the ones v3.2 already flagged as bad coverage axes.

| Market (binary pair) | Typical odds | Boost-eligible | True complement | Notes |
|---|---|---|---|---|
| Odd / Even | ~1.85 / 1.85 | ✅ both | ✅ (T parity) | ideal: eligible + clean |
| BTTS Yes / No | ~1.55–1.90 / 1.80–2.30 | ✅ both | ✅ | ideal |
| Over 2.5 / Under 2.5 | ~1.70–2.10 | ✅ both | ✅ (the v3.2 axis) | ideal |
| Over 1.5 / Under 1.5 | ~1.20–1.45 / 2.8–4.5 | ✅ (Over usually) | ✅ | Over often just clears 1.20 |
| DC 1X / DC 12 | ~1.08–1.35 | ⚠️ often **No** | ❌ overlap | the v3.2 phantom axis — avoid |
| Over 0.5 | ~1.03–1.15 | ❌ | — | classic boost-dead banker |

**Three-way alignment:** the markets that are good for *coverage* (true binaries) are the same
ones that are good for the *boost* (≥1.20), and bad on both counts together (DC overlap + sub-1.20).
The model's market preference is therefore unambiguous: build legs from **Odd/Even, BTTS, O/U 2.5**
(and Over 1.5 where it clears 1.20); avoid DC-short and Over 0.5. The code's existing
`MARKET_COUNTERPART` pairs (BTTS_YES↔NO, OVER_2_5↔UNDER_2_5, ODD↔EVEN) are exactly the good set;
the DC12↔DC1X pair is the one to drop.

---

## 3. What the boost does to EV (and why it's a treadmill)

**Boost mechanics.** Only legs with odds **≥ 1.20** count. The boost **percentage** is set by the
*count* of eligible legs; the **bonus** paid is:

```
boost_bonus = boost%(#eligible legs) × stake × Π(odds of eligible legs)
```

Sub-1.20 legs are invisible to both the count and the base (proven in §1). The bonus only pays on a
full win (every leg correct).

**Full Win Boost schedule** (Betway, "Boost your Multi Bet winnings by up to 1000%"; min odds 1.20):

```
legs boost   legs boost   legs boost   legs  boost
 3    3%     15   35%     27  100%     39   350%
 4    5%     16   40%     28  120%     40   375%
 5    8%     17   45%     29  140%     41   400%
 6   10%     18   50%     30  160%     42   425%
 7   12%     19   55%     31  180%     43   450%
 8   14%     20   60%     32  200%     44   475%
 9   16%     21   65%     33  220%     45   500%
10   18%     22   70%     34  240%     46   600%
11   20%     23   75%     35  260%     47   700%
12   22%     24   80%     36  280%     48   800%
13   25%     25   90%     37  300%     49   900%
14   30%     26   95%     38  325%     50  1000%
```

For the decoded slip at ~6% margin/leg (`p·O ≈ 0.94`):

- No boost: EV = `0.94⁷ − 1 ≈ −35.2%`
- With 8% boost (on eligible odds only): adds `0.08 × 9.6075 / 12.048 = 6.4%` to the return
  multiple → EV ≈ **−31%**. The "8%" became **~+4 EV points** because it rides only the qualifiers.

**Break-even via boost alone** needs `(1−m)^N × (1+b_N) = 1`:

| Margin/leg | 8 legs (14%) | 25 legs (90%) | 31 legs (180%) | 50 legs (1000%) |
|---|---|---|---|---|
| **6%** | −30% | −59% | −59% | −50% |
| **3%** | −11% | −11% | **+9%** | **+140%** |

At normal margins the boost **never** catches the vig — climbing the table adds margin faster
than boost. It flips positive only with genuinely low-margin legs (~3%) at the top tiers. That is
why Betway enforces the **≥1.20 floor**: it blocks farming the 1000% tier with near-locked 1.05
legs (which would be +EV). The boost is a calibrated rebate, not an exploitable leak.

---

## 4. Bet Saver — insurance on the dense middle of the distribution

Bet Saver pays a fixed free bet for near-misses on a 31-leg slip:

| Winning legs | Bet Saver free bet |
|---|---|
| 30/31 | ₦3,634.97 |
| 29/31 | ₦485.95 |
| 28/31 | ₦101.75 |
| 27/31 | ₦29.71 |
| 26/31 | ₦11.35 |

Worked example — 31 legs each @1.20, true p ≈ 0.80, stake ₦1,000:

| Outcome | Probability | Note |
|---|---|---|
| 31/31 (win) | **0.10%** | the jackpot |
| 30/31 | 0.77% | pays ₦3,634.97 |
| 29/31 | 2.88% | pays ₦485.95 |
| 28/31 | 6.95% | pays ₦101.75 |
| 27/31 | 12.2% | pays ₦29.71 |
| 26/31 | 16.4% | pays ₦11.35 |

The win is 1-in-1,000; the "26–30 correct" band is ~**39%** of sessions. Bet Saver pays on that
fat middle. Free-bet EV ≈ **₦54 face → ~₦41 cash** (free bets are worth ~75% of face — you keep
winnings, not the stake). On this slip the main bet is ~−21% and Bet Saver lifts it to ~−17%.

**It is shape, not magnitude** — it harvests the likely near-misses, not the jackpot. Caveats:
the payouts are flat naira amounts (so Bet Saver matters *more* at small stakes), and it lives
only at 31 legs, where compounded margin is already deep.

---

## 5. Co-resolution and the "double-boost" idea — honest reframe

Idea: Slip A (Over 2.5 ×8) + Slip B (BTTS Yes ×8) from the same matches; a 2-1 cluster wins both,
each collects boost. The honest accounting:

- **Not an edge.** Two stakes, two boosts — but also two margins. Boost < margin (§3), so
  `2 × (−EV) = −EV`. The slips are positively correlated (win/lose together on the same
  scorelines), which **raises** variance vs independent bets — concentration, not diversification.
- **But it IS coverage in market-space.** A and B differ: BTTS wins on 1-1 where Over 2.5 loses;
  Over 2.5 wins on 3-0 where BTTS loses. Running both covers more scoreline space than either —
  the v3.2 coverage logic expressed across markets, with boost as a rebate on whichever lands.
- **The real optimization** = leg selection: among co-resolving markets, pick those that are
  (a) ≥1.20, (b) lowest-margin, (c) tier-advancing. The fingerprint preserves the thesis; you take
  the best-priced member. This reaches the −vig floor and maximizes subsidy capture — "closest
  thing to a structural edge without prediction," named correctly as **subsidy capture**.

---

## 6. The learning model — split deterministic from learnable

- **Deterministic — compute, don't learn.** Boost-eligibility (≥1.20), leg-tier targeting,
  margin-minimal substitution within a co-resolution class, Dutch staking, Bet Saver leg-count
  construction. Closed-form; already in `coverage-optimizer.ts`. RL here just refits arithmetic
  while overfitting variance.
- **Learnable — the only real predictive lever.** The **empirical co-resolution rate** in a
  *specific* pool (e.g. how often Over 2.5 actually co-resolves with BTTS in Lithuanian II Lyga
  vs the priced-in correlation). If a league deviates from the implied correlation, that is a
  tiny real edge. Build it as a **statistical estimator of co-resolution correlation** (the
  "market attention matrix"), with confidence intervals — not an RL policy store.
- **The trap.** "Replay strategies that worked" over a handful of sessions, at a 0.1–10% win
  rate, is fitting noise. Structure is deterministic; only the co-resolution *rate* is statistical
  and it needs hundreds of settled matches per league.

---

## 7. Synthesis — what the SSM model should do

1. **True total-goals axis** (kills phantom flips; v3.2).
2. **Coverage of the high-probability cluster**, expressed in **market-space** so each covering
   slip is boost-eligible.
3. **Every leg ≥1.20**, chosen as the **lowest-margin co-resolving** market — prefer Odd/Even,
   BTTS, O/U 2.5 (and Over 1.5 when it clears 1.20); never DC-short or Over 0.5.
4. **Size to the boost tier and Bet Saver thresholds** you're targeting.
5. **Dutch-stake** for uniform covered return (v3.2).
6. **Estimate per-league co-resolution rates** separately — the only component that could add
   real edge — treated as research with honest uncertainty.

**Net:** Win Boost ≈ a ~4-point margin rebate (wasted on sub-1.20 legs); Bet Saver ≈ ~4 points of
tail insurance that reshapes variance; co-resolution = market-space coverage + subsidy capture.
None of it flips EV positive without genuinely mispriced (low-margin) legs. Optimised coverage,
boost-aware, Bet-Saver-shaped. **Not** an edge over the book.

---

## 8. Overlap & redundancy — generalising "no duplicates" (measured)

v3.2 pruned only *exact* duplicates. `lib/ssm/market-overlap.ts` generalises to **partial
overlap**: two markets are redundant coverage if most of one's probability mass also resolves the
other — `sharedOfA = P(A ∧ B) / P(A)`. Measured on realistic games:

**The redundant pair flips with game type:**

| Game type | Redundant pair | Shared mass |
|---|---|---|
| Low-scoring | Under 2.5 ↔ BTTS No | 81% / **91%** |
| High-scoring | Over 2.5 ↔ BTTS Yes | 86% / 85% |
| Any | Odd ↔ Even, BTTS Yes ↔ No | **0%** (true complements) |

**Containment laws (100% shared — fingerprint identities, not coincidence):**
- `Odd ⟹ DC12` (an odd total can't be a draw) — so parity is orthogonal to totals/BTTS but **NOT** to DC.
- `Over 2.5 ⊂ Over 1.5`, `Under 2.5 ⊂ Under 3.5` (ladder containment).
- `BTTS Yes ⟹ Over 1.5` (both teams score ⇒ ≥ 2 goals).

**Caveat learned from running it:** a naive "keep the broadest market, drop everything inside it"
prune is the **wrong objective** — it collapses every game to DC12 / Over 1.5 / Under 3.5 (the
widest, lowest-odds, phantom-prone markets) and discards the clean binary axes. Use overlap to
*detect* redundancy and to *avoid pairing* redundant legs; **select** legs by partition quality +
odds + margin + ≥1.20 eligibility, never by breadth.

## 9. Realistic slip counts & patterns to watch

Measured cover-to-break-even (`costTarget = 1.0`, ₦10,000 bankroll, 6% margin), varying pool size N:

```
N   slips  winRate  return/hit  ceiling(1/R)  affordable ≥₦100
4     9     75.3%    ₦10,532       79.2%         9/9
5    14     73.3%    ₦10,247       74.7%        14/14
6    25     69.5%    ₦10,196       70.5%        25/25
7    45     66.1%    ₦10,124       66.5%        45/45
8    82     63.0%    ₦10,006       62.7%        47/82
```

**Patterns to look out for:**

1. **Slip count explodes ~1.7× per game added** (9 → 14 → 25 → 45 → 82). The break-even cover is combinatorial in N.
2. **Win rate falls toward `1/R` as N grows** (75% → 63%). Short pools simply win more often.
3. **N = 4–5 is the sweet spot:** ~73–75% win rate at break-even, only **9–14 slips**, every slip affordable.
4. **The ₦100 floor truncates large covers:** at N = 8 only 47 of 82 slips clear ₦100 on ₦10k — you literally cannot fund the break-even cover. Bankroll must scale with slip count; another reason to keep N small.
5. **Redundant-pair flip:** low → Under 2.5 ≈ BTTS No, high → Over 2.5 ≈ BTTS Yes; never spend two coverage slots on the pair.
6. **Containment legs add nothing:** a candidate ⊂ a leg you already hold (Odd ⊂ DC12, Over 2.5 ⊂ Over 1.5) is wasted.
7. **Non-adjacent totals lines leave a gap:** Over 3.5 + Under 2.5 (the real Kedainiai lines) miss **T = 3** entirely — use a matched pair, or patch the hole with an Odd leg (T = 3 is odd).

**Takeaway:** the optimiser's job is to prune to **~9–14 high-value, low-overlap slips on a 4–5
game pool** — not to enumerate a matrix. That is the concrete replacement for the brute-force 56.

Tooling: `market-overlap.ts` (+ `__tests__/lib/ssm/market-overlap.test.ts`) — overlap matrix,
redundancy prune, and the slip-count/win-rate-vs-N report; all additive and passing.

---

## 10. Combining Win Boost + Bet Saver — the two-engine portfolio

A slip is **either** boosted **or** Bet-Saver-insured, never both (Betway runs them as separate
programs). The exclusivity only bites at high leg counts — Bet Saver's table is for **31-leg**
slips, while short slips have **only** Win Boost. So the portfolio is naturally **two engines on
two pools**, each tuned to one program.

### Engine A — Boost coverage (short slips, the floor)

The v3.2/v3.3 coverage engine, with every leg ≥1.20 so the whole slip is boost-eligible. Because
the boost is free money on a win, you can cover up to `cost = 1 + boost(N)` and still break even on
wins — which **raises the win-rate ceiling from `1/R` to `(1+boost)/R`**. Measured (₦10k, 6% margin):

```
N   boost  slips  winRate  (vs no-boost)  net-on-win
4    5%     10     80.2%      75.3%        +₦389
5    8%     17     80.7%      73.3%        +₦54
6   10%     31     77.6%      69.5%        +₦50
8   14%    104     71.6%      63.0%        +₦40
```

Sweet spot **N = 5: ~81% win rate, 17 slips, break-even-or-better on every covered win.** The boost
buys ~7 points of win rate for free. High-frequency, low-variance — the floor of the portfolio.

### Engine B — Saver lottery (one long slip, the insured upside)

A 31-leg slip qualifies for both, so you must choose. **On EV, boost wins** — 180% at 31 legs lifts
a 31-fold from ~−72% to ~−21%. But that boost **only pays on 31/31 (~0.1%)** — you will essentially
never collect it. Bet Saver instead pays on the **26–30/31 near-miss band (~39% of sessions)**:

```
31/31 (win)   ~0.10%   jackpot
30/31         ~0.77%   ₦3,634.97 free bet
29/31         ~2.88%   ₦485.95
28/31         ~6.95%   ₦101.75
27/31        ~12.2 %   ₦29.71
26/31        ~16.4 %   ₦11.35
```

So it's the classic **EV-vs-realised tradeoff**: boost has higher *expected* value but you'd need
thousands of slips to ever see it; Bet Saver has lower EV but pays *actual cash* ~39% of the time.
For bankroll survival on a single long slip, choose Bet Saver. (Payouts are free bets — worth ~75%
cash — and appear fixed, so they matter most at small stakes.)

### The portfolio

- **Different pools:** Engine A on ~5 games; Engine B on ~31 games — largely independent.
- **Allocation:** majority to Engine A (the ~81%-win floor); a minority to Engine B (insured upside).
- **Synergy — free-bet recycling:** Engine B's Bet Saver payouts are free bets; route them into
  Engine A's boosted slips (free bets favour higher-odds covered legs). The lottery feeds the floor.

**Honest position:** both engines are −EV; the mix doesn't change that. It *shapes the distribution*
— a high-frequency near-break-even floor (boost coverage) plus a fat-tailed, near-miss-insured
lottery (saver) whose free bets recycle back — capturing the maximum subsidy from **both** programs
at the leg counts where each is available.

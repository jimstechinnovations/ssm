# Learnings & explored ideas (2026-07-19)

Everything here was **measured on live SportyBet odds**, not assumed. These are ideas we explored to
understand the ceiling of the system. **None of them is shipped as a default** — the working build is
still the Under-4.5 realizer that produced [S-863EB4](../app/sessions). This file preserves *why*, so a
later refinement doesn't re-walk the same ground. The honest bar throughout: measured on **book
marginals**, no look-ahead, before/after recorded.

> **The one invariant.** Every slip is −vig. Nothing below creates edge; it only reshapes the bet
> (variance, coverage, leg-efficiency). The only avenue that could ever flip EV positive is a
> **reference price sharper than the placing book** (line-shopping / CLV) — see `algorithm.md §11`.

---

## 1. The realizer is already P(win)-optimal
`P(≥1 win) = Σ P(vector = reality)`; disjoint outcomes ⇒ maximized by covering the K *most-probable*
vectors — exactly what the realizer does. No dispersion / re-selection beats it. The big early cut
(e.g. 467/600 on the first Over game in S-863EB4) is the **calibrated floor** `(1−overProb)·K` — not a
bug, and unavoidable without over-betting a low-probability event. Built `cutRiskProfile` for visibility
(per-game exposure), not prevention. → memory `realizer-already-optimal`.

## 2. Layers 1 & 2 are ~free, and they shrink the coverage need
Relaxing L1 (≤50% Over) / L2 (no 3-run) moved P(win) ~0.3% — the pruned days are too rare to matter.
More importantly, the layers **collapse the space you must cover**: at 9 games, 2⁹ = 512 outcomes drop
to **213 realistic** vectors. So 600 slips fully cover the realistic outcomes of **~11 games** (not a
naive 9), and beyond that the realizer covers the top-600 most-probable, so P(win) fades gracefully
(38% @13, 22% @15) instead of a cliff. **Ceiling:** even perfect realistic coverage caps P(win) at
~70% — the layers prune the wild ~30% of days, which you then don't cover.

## 3. Full coverage = guaranteed win, guaranteed −EV
Because ₦6,000 = 600 slips and layers shrink the space, you *can* guarantee a winner every session (fully
cover the realistic outcomes). But it keeps only ~49–61% → a guaranteed **loss** on average; the median
winning slip returns *less* than the total staked, and covers the ₦6k budget only ~13% of the time.
Fewer legs loses less (keep 0.61 at 9 games vs 0.21 for a 24-leg moonshot) but pays small. It's a
**variance dial** (always-win-small ↔ rarely-win-huge), not a profit dial.

## 4. Multi-line anchors (Over 1.5 / Under 3.5 / …) — built, NOT better
Generalized the engine to respect each axis's `dominantSide` (a real correctness fix; `market_policy`
option, off by default). Grounded A/B on 131 live games: multi-line recovers the whole pool but is
**worse on P(win)** (5.6% vs 7.4% at cover+50%). Cause: the **≥1.20 boost gate forces every usable
anchor to ~72% reliability** (the safe Over 1.5 @ ~1.05 never qualifies), and the target is reached with
the highest-odds = riskiest legs. Under 4.5 @ ≥1.20 is already the sweet spot. → memory
`multiline-anchors-not-better`.

## 5. "Use the market that wins when Under loses" (GG/Over 2.5) — proven neutral
Swapping Under 4.5 → Over 2.5 doesn't make a leg safer; it moves the losing outcome from "5+ goals" to
"0–2 goals", equally likely. Proven on live odds: an Under-4.5 family and an Over-2.5 family on the same
games are each −vig (kept 0.21 / 0.38 per ₦1) and their win-days are **anti-correlated** (corr −0.24;
both-win 0.17% vs 4% if independent). Running both reshapes *when* you win, never *whether* you profit.
Same-game market stacking is barred anyway (correlated → SGM with adjusted odds; our engine would lie).

## 6. SportyBet Multi Bet Bonus — captured and SHIPPED (the one real improvement)
The adapter had used ZERO boost. Captured the real MBB from live betslips (plan MBB_1699286159923,
`qualifyingOddsLimit` = 1.20 — the reason `MIN_DOMINANT_ODDS` is 1.20). Realized bonus: 9 legs 30%,
20 → 92%, 35 → 231% (bigger than Betway's at low legs). Odds-dependent; stored the conservative
all-Under table. Effect: builds reach a target with **fewer legs** (→ better realistic coverage,
higher P(win)) and show **accurate** payouts. Still −EV (bonus never overcomes the compounding vig).
→ memory `sportybet-boost-captured`. **This is the only change here that alters the default build.**

## 7. Optimal budget/legs for "cover + profit" (honest frontier)
Every configuration is −EV. For a fixed stake, **smaller budget + fewer legs + lower profit tier** gives
the best honest P(win) (₦2,000 / ~24 legs / cover+50% ≈ best odds on a synthetic pool). Bigger budgets
need bigger targets → more legs → *lower* P(win). "Optimal" = best-shaped shot within budget, not profit.

---

## What to refine later (grounded next steps)
- **Boost is odds-dependent** — the shipped table is the conservative all-Under case. A per-slip boost
  (function of leg count *and* total odds) would price flipped slips exactly. Capture the min/max→odds
  mapping from `bonus/plans/valid` + betslip reads.
- **Server + multi-account placement** (see `placement-architecture.md`) — the real speed/reliability win.
- **Sharp-reference edge** — the only honest +EV avenue; needs a price feed sharper than SportyBet.

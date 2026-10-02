# Decision Bot — learnings from real money

A living record of what settled, real-money sessions say about the Decision Bot. **Append to the session log
after every run** (numbers come from `python scripts/session-learnings.py`), and treat every "proposed"
change below as a hypothesis until a later session confirms it on data it wasn't fitted to.

Last updated: 2026-10-02, after the ₦3,000 run of 1 October (299 slips, 24 still alive at writing).

---

## 1. Lifetime ledger

| Run | Engine | Slips placed | Stake | Target | Won | Honest P(≥1 win) at build |
|---|---|---:|---:|---:|---:|---:|
| 17–20 Jul (S-03CFC8, S-C76259, S-863EB4, S-BB610F, S-51A2A4) | legacy Under-4.5 | 2,098 | ₦20,980 | ₦100–₦500k | 0 | ≈ 28% combined (mostly S-51A2A4 at ₦60k and the 2-slip ₦100 test) |
| 26 Sep (S-A1FA6F) | Decision Bot, no skip | 100 | ₦1,000 | ₦51k | 0 | 1.4% |
| 1 Oct (S-2A4472, S-7A14B6, S-F2AA60, S-222131, S-3EC9BA, S-DB2F41) | Decision Bot, skip + 8-leg cap | 299 | ₦2,990 | ₦51k | 0 so far (24 alive) | ≈ 4.8% |
| **Total** | | **2,497** | **₦24,970** | | **0** | **expected wins ≈ 0.35** |

**Zero wins is the expected outcome, not a malfunction.** The honest win chances above add up to about 0.35
expected wins across everything ever placed, so getting no win at all had roughly a 70% chance. Every
real-money result so far is consistent with the maths. It also means the record can't yet say anything
about *edge*. Nothing in this system claims one: the bookmaker keeps ~18–38% of every stake, by
construction.

## 2. Is the bot doing what it says? (1 Oct run, 299 slips)

| Check | Predicted | Actual |
|---|---:|---:|
| Legs that won, of 1,381 graded | 50.8% | **50.1%** |
| Slips still alive after the finished games | 24.9 | **24** |
| Draws (45 games, each game counted once) | 9.2 | 13 (z = +1.4) |
| Over 2.5 goals (43 games) | 24.5 | 25 (z = +0.2) |
| Both teams score (44 games) | 22.6 | 25 (z = +0.7) |

The probabilities are well calibrated. The 26 Sep run said the same (45.1% vs 43.5% over 856 legs).

**Method warning.** At the *leg* level the same game sits under many slips, so leg counts overstate
certainty. "Home or Away" looked catastrophic at the leg level (59% vs 80%, z = −4.0), but counted once per
game it became the mild draw lean above (z = +1.4). Only game-level tests justify changing the model.
`scripts/session-learnings.py` prints both levels and labels them.

## 3. Findings

1. **Draws: a lean to watch, not yet a finding.** 29% of games drew against the ~20% the book priced
   (internationals 29%, clubs 20%). Plain Poisson-style models are known to under-predict draws, so a real
   bias is plausible. But z = 1.4 on 45 games is well within luck. **Action:** keep logging; if the
   game-level draw z stays above +2 over ~150+ games, add a draw correction (Dixon–Coles style) to the
   scoreline table. That is the one data-driven "flip" rule this record could eventually justify.
2. **Clean-sheet markets: drop them.** This isn't about results. They carry the worst bookmaker margin of
   any market the bot uses (keep 0.917–0.924 per leg against 0.95–0.96 for 1X2, totals and team totals,
   measured 26 Sep), and every leg's margin compounds into the slip. Removing them raises the slip-level
   keep, and so P(win), at no cost.
3. **History (H2H) doesn't move the needle — yet.** Only 72 of 1,381 legs had any past meetings to cite
   (most of the board is lower-league and international fixtures Sofascore barely covers). Where H2H agreed
   with the pick, the leg won 83% vs 69% predicted, but that's 23 legs on a handful of games: noise.
   History stays a cited reason, never a filter (a filter cut 103 games to 7 on 1 Oct and broke the build).
4. **Pick reasons.** Legs from the *random* generator ran slightly under their predicted rate (42.3% vs
   45.5%), *weighted* exactly on (59.9% vs 59.8%), *separator* slightly over (47.9% vs 44.1%). All within
   leg-level noise; no generator is broken. The final choice is always the greedy's: highest
   win chance minus overlap.
5. **Survival is a straight line in budget, and the ceiling is fixed.** P(≥1 win) ≤ keep × budget ÷ target.
   The fingerprint greedy reaches 95–98% of that ceiling, so cleverer slip selection can't add much. What
   moves the ceiling is keep (fewer legs, low-margin markets) and the budget/target ratio.

### What 500 slips would have done (₦5,000 at ₦51k, same settings)

| | 299 slips (actual) | 500 slips |
|---|---:|---:|
| P(≥1 win), honest | ≈ 4.8% | ≈ 8% |
| Still alive at this point (scales with slips) | 24 | ≈ 40 |
| Expected loss (≈ 18% of stake) | ≈ ₦540 | ≈ ₦900 |
| Slips for a 50/50 chance of one winner | — | ≈ 3,100 slips / ₦31,000 |

More slips buy more survival in proportion to the money, never faster. The fingerprint scorelines make
sure no two slips win in the same result, so each extra slip adds its full chance. That's why coverage
keeps scaling, but it can't scale for free.

### Flipping, in hindsight vs in advance

After results come in, any losing leg could have been "flipped" to its complement and won. One final
score satisfies many selections at once, which is exactly what the fingerprint table models. But that
can't be acted on before kickoff. A flip rule only helps if the bot is *systematically* wrong in one
direction, which is what the calibration checks test. So far: no market is systematically wrong except
possibly draws (finding 1). A flip also changes the odds, so the slip has to be re-balanced to stay in
the target band.

## 4. Operational lessons (cost real time on 1 Oct)

| Problem | What happened | Status |
|---|---|---|
| Build time cap | 200-slip budget split into 6 mini-sessions: each build hit the 180 s cap at 30–79 slips | Fixed 2026-10-02: the build no longer blocks the server (below), so the cap is now 15 min. One budget should fit one session; not yet measured on a full 200-slip build |
| Server froze during builds | The bot's search ran synchronously on Node's only thread and blocked every request | Fixed 2026-10-02: the bot is a generator that yields to the event loop (`runDecisionBotAsync`). Chosen over a worker thread: same effect, no serialization of the game tables |
| SportyBet blocked server-side requests | TCP/TLS-level drop of non-browser clients after heavy automated use | Fixed: booking codes, odds feed, and (2026-10-02) bonus plan, results and the pre-flight check all go through CDP (`lib/placement/cdp-fetch.ts`, `scripts/place-session.mjs`) |
| Faro-wrapped `window.fetch` | SportyBet's monitoring SDK broke in-page requests | Fixed: the placer uses a throwaway iframe's fetch; server fetches use one dedicated tab on `sportybet.com/robots.txt` (no scripts there, so fetch is native), never the placer's tab |
| Sofascore 403 on history sync | Sync script swallowed every error and reported 0 found | Fixed 2026-10-02: every request is counted (ok / not found / blocked / failed) and reported; the sync stops with an explicit error once most requests fail |
| 46% skipped at floor 100% | Odds drift between build and place | Fixed: `floorPct` + requeue. Default is now 70% in the UI, the place route and the placer CLI (2026-10-02) |
| "Uncertain" slip | No success popup; the balance proved it placed | Works as designed (verify state). Balance math is the tiebreaker |
| **No internet connection** (the 1 missed slip) | The connection dropped; the tab sat on a "No internet" page; every retry spent an attempt on a dead connection, the error page looked like a worker crash, respawns failed the same way, and the slip ran out of attempts | Fixed 2026-10-02: the placer detects the offline page (`chrome-error://`, `navigator.onLine`, ERR_INTERNET_DISCONNECTED, SportyBet's own notice), waits for the network, reloads, and re-runs the same slip without spending an attempt. It gives up after `--net-wait-min` (20) and leaves the slips queued. Detection was checked on a real offline tab |
| Leaked Chrome processes | 188 processes, 0.44 GB free RAM, everything slowed | Fixed 2026-10-02: server fetches reuse one tab, and "Prepare browser" closes blank and duplicate fetch tabs (never a SportyBet page). Still: run fewer ad-hoc debug scripts against the live browser |

## 5. Proposed changes for the next bot (in priority order)

Status as of 2026-10-02. What was built is described in `algorithm_v1.md` §0.5.

1. **Drop clean-sheet markets** (finding 2). Free keep. **Done**: `DROPPED_MARKETS` in
   `lib/pedlas/selections.ts`, guarded by a test.
2. **Build without blocking, one session per budget** (operational 1). **Done** (non-blocking generator,
   15 min budget). Measure a full 200-slip build on the next run.
3. **Route the bonus plan, results and pre-flight through CDP** too. The last runs priced bonus from the
   fallback table. **Done.** Check the next build's note says "live plan", not "fallback table".
4. **Add P and keep to every leg's reason.** A reason used to read "random pick (u=0.011) of 42: Home
   over 2.5 @4.7 · history: 0/2". **Done**: it now adds "P 21.0%, keeps 0.987", and flags a leg under
   1.20 as earning no bonus.
5. **Watch the draw lean** (finding 1). Rerun the script after each run; act only on the game-level test.
   **Open (watch only, by design).**
6. **Bench `allow_sub_min_legs=false`.** Legs under 1.20 don't earn bonus. An earlier bench measured P(≥1)
   at 0.64% without them against 0.60% with them. **Open**: re-bench before changing the default.

---

## Session log (add a row to this table after every run — newest last)

| Date | Sessions | Slips | Legs graded | Leg hit / predicted | Alive / expected | Draw z (games) | Notes |
|---|---|---:|---:|---|---|---|---|
| 2026-09-26 | S-A1FA6F | 100 | 856 | 45.1% / 43.5% | 0 / — | — | first Decision Bot run; floor feature born |
| 2026-10-01 | S-2A4472 … S-DB2F41 (6) | 299 | 1,381 | 50.1% / 50.8% | 24 / 24.9 (mid-run) | +1.4 (45) | skip + 8-leg cap; CDP fixes; 2 slips never staked |

How to add a row: `python scripts/session-learnings.py <session codes>` once the games finish, then copy
the CALIBRATION and GAME level lines into a new row.

---

# Appendix: earlier explorations (July 2026, legacy Under-4.5 engine)

> Preserved verbatim from the previous version of this file (commit cc75cca). It covers the engine that
> placed the July sessions; the Decision Bot findings above build on it, and its invariant still holds.

## Learnings & explored ideas (2026-07-19)

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

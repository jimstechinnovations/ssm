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
| Build time cap | 200-slip budget split into 6 mini-sessions: each build hit the 180 s cap at 30–79 slips | **Proposed:** run the build in a worker thread (not the server's main thread), then raise or remove the cap so one budget = one session |
| Server froze during builds | The bot's search ran synchronously on Node's only thread and blocked every request | Fixed: wall-clock budget (`deadlineMs`). Worker thread above is the real fix |
| SportyBet blocked server-side requests | TCP/TLS-level drop of non-browser clients after heavy automated use | Fixed for booking codes + odds feed via CDP (`lib/placement/cdp-fetch.ts`). **Still raw:** bonus plan (fell back to the stored table), results, pre-flight check |
| Faro-wrapped `window.fetch` | SportyBet's monitoring SDK broke in-page requests | Fixed: clean fetch from a throwaway iframe |
| Sofascore 403 on history sync | Sync script swallowed every error and reported 0 found | Open: make sync errors loud |
| 46% skipped at floor 100% | Odds drift between build and place | Fixed: `floorPct` (70% default for big targets) + requeue |
| "Uncertain" slip | No success popup; the balance proved it placed | Works as designed (verify state). Balance math is the tiebreaker |
| Leaked Chrome processes | 188 processes, 0.44 GB free RAM, everything slowed | Open: close CDP pages reliably; run fewer ad-hoc debug scripts against the live browser |

## 5. Proposed changes for the next bot (in priority order, none built yet)

1. **Drop clean-sheet markets** (finding 2). Free keep.
2. **Build in a worker thread, one session per budget** (operational 1).
3. **Route the bonus plan, results and pre-flight through CDP** too. The last runs priced bonus from the
   fallback table.
4. **Add P and keep to every leg's reason.** Today a reason reads "random pick (u=0.011) of 42: Home
   over 2.5 @4.7 · history: 0/2". Add "P=31%, keeps 0.95", so each choice states its own odds of
   surviving.
5. **Watch the draw lean** (finding 1). Rerun the script after each run; act only on the game-level test.
6. **Bench `allow_sub_min_legs=false`.** Legs under 1.20 don't earn bonus, and an earlier bench measured
   0.64% vs 0.60% P(≥1) without them.

---

## Session log (append newest at the bottom)

| Date | Sessions | Slips | Legs graded | Leg hit / predicted | Alive / expected | Draw z (games) | Notes |
|---|---|---:|---:|---|---|---|---|
| 2026-09-26 | S-A1FA6F | 100 | 856 | 45.1% / 43.5% | 0 / — | — | first Decision Bot run; floor feature born |
| 2026-10-01 | S-2A4472 … S-DB2F41 (6) | 299 | 1,381 | 50.1% / 50.8% | 24 / 24.9 (mid-run) | +1.4 (45) | skip + 8-leg cap; CDP fixes; 2 slips never staked |

How to add a row: `python scripts/session-learnings.py <session codes>` once the games finish, then copy
the CALIBRATION and GAME level lines into a new row.

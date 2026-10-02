# algorithm_v1 — the Decision Bot (target-driven, multi-market, logged)

> Status: **BUILT (2026-09-25)** and the default engine; see [§0](#0-what-was-built-and-verified). Changes
> after the first real-money runs (2026-10-02) are in [§0.5](#05-changes-after-real-money-2026-10-02). The
> Coverage tab (survivors, both ways, slips and budget) is [§0.6](#06-coverage-survivors-both-ways-slips-and-budget-2026-10-02). §1–§8
> below are the original spec, kept as written, with corrections marked **[corrected]**. The worked
> example is reproducible: `node scripts/algorithm-v1-example.mjs 10 200 5 7` (read-only; nothing placed).

This document does three things:

1. **§0:** what was built, the decisions taken, and what was verified on the real site.
2. **§1–§3:** how the algorithm evolved in this codebase, what each version measured, and what the real
   settled record says.
3. **§4–§8:** the Decision Bot spec, with worked maths on real odds and an honest EV section.

---

## 0. What was built and verified

**Your decisions.** Payout band **1%** (configurable). Rule **greedy** (configurable: greedy / weighted /
random / flip). Legs under 1.20 **allowed** (configurable). **History used**: every pick's reason cites
how that pick did in the two teams' past meetings. **[corrected 2026-10-01]** History is no longer a gate
(see §0.5): it is cited data, and every scanned game is usable.

| Piece | Where | What it does |
|---|---|---|
| Selection catalogue | `lib/pedlas/selections.ts` | Two-sided pairs per game (1X2↔Double Chance, totals, team totals, BTTS, odd/even; clean sheets **dropped 2026-10-02**, see §0.5). Each selection is a scoreline **rule**, used to price, explain and settle. Game order: kickoff → shortest name → A–Z. |
| Calibrated scoreline table | `lib/pedlas/scoreline-table.ts` | Poisson start plus iterative fitting to **every** de-vigged market, so no selection can look better than fair (worst fit on live odds: 1.6pt). |
| Decision Bot | `lib/pedlas/decision-bot.ts` | Builds slips one by one, walking games in order, closing each slip inside [T, 1.01·T], and logging every pick. |
| Fingerprint greedy | same | Each slip's fingerprint is the set of score combinations it wins on. Greedy scores candidates by P(win) minus the overlap with earlier slips (exact, from the tables), and prefers **fingerprint-disjoint** slips (pairs that can never both win). Candidates come from three generators: uniform, probability-weighted, and a *separator* that picks selections sharing no scoreline with slips it still overlaps. |
| SportyBet bonus | `lib/books/sportybet-bonus.ts` | The site's **own** Multi Bet Bonus formula, read from its live plan (below). |
| Session builder | `lib/pedlas/build-bot.ts` | Feed → history gate → bot → stored legs (booking-code ids, rule, reason, probability). |
| Rule-aware settlement | `lib/pedlas/settle-slips.ts` | Every market settles from the final score (home–away), with early cut. |

**Measured (live odds, ₦1,000 → ₦100,000, exact live bonus):**

| Rule | legs < 1.20 allowed | only ≥ 1.20 |
|---|---:|---:|
| greedy (fingerprint) | **0.60%** · keep 0.60 | **0.64%** · keep 0.65 |
| random | 0.43% · keep 0.43 | 0.51% · keep 0.52 |

At a lower target, where fingerprint overlap matters (₦1,000 → ₦5,000): greedy **14.95%** vs random
12.82% vs flip 8.67%. Flip overlaps the most (5.5pt), because slip 3 flips slip 2 back towards slip 1.

**Verified on the real site (dry runs, nothing staked).** Every bot slip's booking code loads on the
SportyBet betslip with exactly its games, including 1X2, clean-sheet and team-total legs. The built payout
equals the betslip's Potential Win **to the kobo** (4/4 slips: ₦5,031.39 / ₦5,049.07 / ₦5,031.76 / ₦5,015.34).

### The SportyBet bonus: what we got wrong, and the real rule

SportyBet changed plans on 2026-09-09 (`MBB_1788955181864`). The stored table came from the July plan and
overstated long slips about 2× (20 legs: stored 92%, real 42%). **[corrected]** §4.2 and §8 said a leg
under 1.20 "breaks the bonus for the whole slip". **That is false:** such legs simply don't count.
The real rule, read from the site's own code and live plan (`GET /api/ng/promotion/v2/bonus/plans/valid`):

```
qualifying legs = odds ≥ 1.20            n = how many;   plan gives a [min, max] range for n
Q      = Π qualifying odds
rtp    = Π (odds × p)                    p = SportyBet's own outcome probability (in the feed)
target = Σ odds²·p / Σ odds              (rounded to 4 dp)
pct    = floor₂(target / rtp − 1), clamped to [min, max × bonusFactor]   (football bonusFactor 0.6)
bonus  = stake × Q × pct                 payout = stake × Π all odds + bonus
```

For every realistic accumulator the clamp binds, so the bonus is **plan max × 0.6**: for example 4 legs
4.8%, 6 legs 9.6%, 10 legs 19.8%, 20 legs 42%. Builds read the plan live, so a future plan change is
picked up automatically.

### Placement: multi-PC, no double placing

See `docs/placement-architecture.md`. In short: slips are claimed from a shared database queue with a
lease. A slip enters "submitting" (the point of no return) only while its lease is live, right before
Confirm. A slip whose placing PC died mid-submit goes to "verify" and is checked against bet history,
never re-placed on a guess. Submits are serialised per account across PCs, with **one placer per Chrome**
(a Chrome's tabs share one betslip). Every slip is re-checked on the betslip, inside the submit lock,
right before Confirm, and a slip whose site payout is below target is skipped.

---

## 0.5 Changes after real money (2026-10-02)

Source: 2,497 slips placed lifetime (₦24,970), and the 1 Oct run of 299 slips analysed leg by leg and game
by game in [docs/learnings.md](docs/learnings.md). That run showed the model is **calibrated**: legs won
50.1% against 50.8% predicted, and 24 slips alive against 24.9 expected. Nothing below changes the maths
of a pick. Every change either removes a cost or removes a way the system failed to place.

### What the bot no longer does (avoid / drop)

| Change | Why | Where |
|---|---|---|
| **Clean-sheet markets dropped** (SportyBet ids 31, 32) | Highest bookmaker margin of any market we used: a leg keeps 0.917–0.924 of its stake in expectation, against 0.95–0.96 for the rest. P(≥1 win) ≤ keep × budget ÷ target, so a worse keep is lost P(win) on every slip it enters, with no offsetting gain. | `DROPPED_MARKETS` in `lib/pedlas/selections.ts`. The settle rule stays, so old slips still settle. A test guards it. |
| **History is not a filter** | Requiring form on both teams cut 103 games to 7 on 1 Oct, and a Sofascore block then left nothing to build with. The live price is already the honest probability; history only explains. | `lib/pedlas/build-bot.ts` (`requireHistory` is accepted and ignored). |
| **No silent skips for small drift** | At floor 100%, 46% of one run was skipped because odds moved a little between build and place. | Default `floorPct` is now **70** (UI, place route, placer CLI). A payout is still never placed below the session budget. |

### What every pick now says

Each leg's reason now carries its own survival odds and cost, not just how it was picked (illustrative numbers):

```
random pick (u=0.011) of 42: Home over 2.5 @4.70 · P 21.0%, keeps 0.987 · history: 0/2
Under 0.5 @1.08 · P 90.1%, keeps 0.973, under 1.2 so no bonus · history: 3/4
```

`P` is the calibrated probability the leg wins. `keeps` is P × odds, the fraction of the stake the leg
returns in expectation. A leg under 1.20 is flagged because it earns no bonus.

### Reliability: the failures of 1 Oct, and what handles each now

| Failure seen | Handling now |
|---|---|
| SportyBet's edge drops our server's raw requests (TLS fingerprint, not IP) | Every SportyBet call runs inside the real Chrome over CDP when it is up: booking codes, odds feed, **bonus plan, results, pre-flight**. Raw fetch is only the fallback. `lib/placement/cdp-fetch.ts`. |
| CDP fetch touching the placer's tab; Faro's wrapped `window.fetch` | One dedicated tab parked on `sportybet.com/robots.txt` (same origin, no scripts, so a native fetch), reused across calls with a lock. Every tab-picker skips it. |
| Server frozen while a build ran | The bot is a generator that yields to the event loop (`runDecisionBotAsync`), so the server keeps answering. The build budget is 15 minutes instead of 3, which should let one budget be one session (not yet measured on a full 200-slip build). |
| **No internet connection** mid-run (cost the one missed slip) | The placer detects Chrome's offline page (`chrome-error://`, `navigator.onLine`, ERR_INTERNET_DISCONNECTED) or SportyBet's in-page notice. It pauses, waits for the network, reloads SportyBet and re-runs the **same** slip **without spending an attempt**. It gives up after `--net-wait-min` (20 by default) and leaves the slips queued. |
| Sofascore 403 reported as "0 found" | Sync scripts count every request (ok / not found / blocked / failed), report them, and stop with an explicit error once most requests fail. |
| Leaked Chrome tabs (188 processes, 0.44 GB free) | "Prepare browser" closes blank and duplicate fetch tabs, but never a SportyBet page. CDP fetch reuses one tab. |

### Deliberately not changed

- **Draw lean.** Draws came in at 29% against 20% priced, but the game-level test gives z = +1.4 over 45
  games, which is not significant. Leg-level tests overstate it, because one game sits under many slips.
  Watch it with `scripts/session-learnings.py`, and act only on a game-level result.
- **Legs under 1.20.** Still allowed. An old bench measured P(≥1) at 0.64% without them against 0.60% with
  them: a small gap from one bench. Re-bench before changing it.
- **The honest ceiling.** P(≥1 win) ≤ keep × budget ÷ target still holds. None of these changes beats it.
  They only stop us falling further below it.

---

## 0.6 Coverage: survivors, both ways, slips and budget (2026-10-02)

The session page has a **Coverage** tab (`components/CoverageTab.tsx`, `GET /api/sessions/[id]/coverage`,
maths in `lib/pedlas/survivors.ts`). It answers "do we have enough survivors for at least one to land?"
before placing (plan mode) and while the games run (live mode). By default it combines every session from
the same day, because one budget is often split across sessions.

**How it works.** Each game's scoreline table is rebuilt from the probabilities the legs were priced at.
Every distinct pick on the game is fitted (iterative proportional fitting) to its stored P, so picks on
the same game stay correlated as the book prices them. Games are independent of each other. Then it
simulates. Two passes use the same tables:

- **Now:** finished games settle legs. Games **in play** kill a leg as soon as no final score can win it
  (an Under 0.5 dies at the first goal), as SportyBet does. The remaining games are simulated over the
  slips still alive.
- **Plan:** every game not started, over the whole family. This is what the family was worth before
  kickoff. Budget answers come from this pass, because a slip that already survived six games is worth
  far more than a fresh one. Pricing new slips off survivors would overstate them about 9×.

**What it shows.**

| Question | Shown as |
|---|---|
| How many are really alive? | Alive now (full time + in-play kills). **Check SportyBet** reads the account's open bets (`realbetlist?isSettled=0`) and matches each to our slip by its exact selections. On 2 Oct: 16 alive here, 16 open on the site, all 16 matched. |
| Both ways, per game | Picks riding on the game; the chance it cuts every slip on it (**one-sided** at ≥ 50% with 2+ slips); for each likely score, the slips left on it and the chance of at least one win **after** that score. |
| Does each closed game make it smaller or bigger? | **Both.** A game that goes our way removes its uncertainty, so the chance rises. A game that cuts slips lowers it. Averaged over all results, today's chance equals tomorrow's expected chance; there is no drift. The timeline shows each move (e.g. 2 Oct: CA Platense 1–0 took it from 3.6% to 7.2%; Seattle 2–1 then cut 4 slips and it fell to 2.35%). |
| How deep does at least one survive? | P(≥ 1 slip alive) and expected survivors after each game; "survives the first K games with ≥ 90%". |
| How many slips / what budget? | P(≥ 1 win) as slips are added (the curve), and the slips/budget for 5 / 10 / 25 / 50%. The floor column is the zero-overlap bound `goal × target ÷ (keep × stake)`. In live mode, the **top-up**: new slips on games not started that would lift today's chance to each goal. |

**Measured on the 1 Oct family (299 slips at ₦51,000):** 4.66% before kickoff (the six builds' own
figures add to 4.8%; the gap is overlap between sessions), keep 0.83, 95% of the summed chance
survives overlap. To reach 10% from scratch: about 655 slips (₦6,550). The floor with zero overlap is
618. Every line costs about budget × (1 − keep) on average: a bigger budget buys a bigger chance, never
an edge.

**What it does not do.** It doesn't change how the bot picks. The bot's objective is already P(≥ 1 win)
with exact pairwise overlap. A one-sided game costs P only through overlap, which the objective already
counts. The tab makes the trade visible before money goes in. Use it to choose the budget, and to rebuild
when the plan shows one-sided early games.

---

## 0.7 Honest leg ratings, a price panel, the floor, and stake size (2026-10-02)

Everything here was measured on the live board on 2 Oct. Nothing in this section has been staked yet.

### Leg ratings: the bot was chasing its own model's errors

The bot used to rate each leg with the fitted scoreline table, which overrates big underdogs ("Home win
@35" at 4.0% when the fair price is about 2.7%). Greedy then preferred exactly those legs: 276 of the 299
slips placed on 1 Oct held at least one.

- **Fix:** a leg's P is now the book's own fair probability. `BotConfig.legProb` is `'panel'` by
  default, falling back to `'book'`. The table is kept only for how two picks on the same game overlap.
- **Bench** (same live board, ₦500 → ₦51k, skip mode, max 8 legs, all scored at the book's prices):

| Ratings | Headline it claimed | Real chance | Back per ₦1 | Long shots (odds ≥ 10) |
|---|---:|---:|---:|---:|
| old model | 0.69% | 0.35% | 0.35 | 32 |
| book | 0.46% | **0.46%** | **0.48** | 1 |

### The reference price panel (`lib/books/reference.ts`, `pinnacle.ts`, `kambi.ts`, `panel.ts`)

- **Sources:** Pinnacle (sharp, weight 2) and Kambi (the Unibet / 888 / LeoVegas platform, weight 1),
  both public read-only feeds. Each is de-vigged with the power method, matched to SportyBet games by
  team names plus kickoff time, and combined into a consensus.
- **Guard:** a pairing whose 1X2 is more than 12 points from SportyBet's own is dropped as a wrong
  match. Before the guard, the biggest "overpays" were exactly those (Truro City "Away win @14": 27% vs
  6.2%).
- **What it found** (`scripts/sharp-probe.ts`, 3,406 picks priced):
  - SportyBet's own probability equals Pinnacle's (median ratio 1.000);
  - its odds sit about 7% under fair (median odds × P = 0.933; top tenth ≥ 0.985);
  - Pinnacle and Kambi differ by a median 1.4 points;
  - picks overpaid by more than 2% with both sources agreeing: **1**.
- **Conclusion:** no "value" picking edge on SportyBet's pre-match board. The panel's job is honest
  ratings, catching stale lines, and refusing wrong pairings.

### Stake size is the biggest lever

SportyBet's bonus is dynamic: it shrinks for low-margin legs, so the margin can't be "bought back" with
the bonus. With honest prices and the exact bonus, the best return per ₦1 a slip can reach falls as the
payout multiple rises:

| Multiple (target ÷ stake) | 5,100× | 1,000× | 510× | 100× | 20× |
|---|---:|---:|---:|---:|---:|
| Best back per ₦1 | 0.72 | 0.78 | 0.82 | 0.87 | 0.95 |

The chance of at least one win ≈ keep × budget ÷ target, so for the same budget and the same ₦51k target,
₦100 slips (510×, about 6 cheap legs) beat ₦10 slips (5,100×, 8 expensive legs). With ₦2,000:

| Stake | Slips | Keep | Chance of ≥ 1 win |
|---:|---:|---:|---:|
| ₦10 | 200 | ≈ 0.45 | ≈ 1.8% |
| ₦100 | 20 | ≈ 0.75–0.82 | ≈ 2.9–3.2% |

### The floor (`lib/pedlas/floor.ts`; design in `docs/near-miss-design.md`)

- **What it is:** a share of the budget (0–50%, the New session "Floor" control) buys SportyBet Flexi
  "at least k of 8" tickets on likely, low-margin legs, away from the jackpot slips' games. Each returns
  ≈ ₦0.95 per ₦1 and lands about 45–75% of the time.
- **Settlement:** at least k right (`settleSlip(..., { minCorrect })`).
- **Survival:** floor tickets are left out of the survival maths.
- **Placer:**
  - switches the betslip to Flexi and sets k through the betslip's own selector;
  - verifies through SportyBet's own state (the on-screen label lags) and against the built payout (±5%);
  - before *every* slip, makes a jackpot slip a plain multiple, or refuses;
  - skips a floor ticket that has lost a leg to suspension, because "k of N" would change.
- **Grounded on S-06AF70** (dry run, nothing staked): 20 of 20 slips loaded. The 5 floor tickets showed
  "6+ of 8" at the built price to the kobo (₦14.64 vs ₦14.63, ₦17.26 vs ₦17.27, …). With the betslip
  forced into Flexi, the next jackpot slips still went in as plain multiples at full price.

### Reliability fixes found along the way

- **`cdpFetch`:** every in-browser fetch is time-boxed, unfreezes the tab and retries once, then falls
  back to a plain fetch. Chrome froze the background fetch tab and two runs hung for 10+ minutes.
- **Chrome launch:** `TabFreeze`, `HeuristicMemorySaver` and `IntensiveWakeUpThrottling` are now off.
  Chrome honours only one `--disable-features` flag, so they joined the existing one.
- **New session** now sends skip mode with an 8-leg cap. It was benched +26% on 1 Oct but only ever set
  through the API by hand.

---

## 1. The one rule that never changes

A bookmaker prices every selection with a margin. For a two-sided market with odds `a` and `b`:

```
margin  m = 1/a + 1/b − 1                         (typically 4–7% on SportyBet, see §6)
keep per leg = P(leg wins) × odds = 1/(1+m)       (≈ 0.93–0.96 with fair probabilities)
keep of a slip = (1 + bonus(L)) × Π keep_leg      (< 1 for every realistic slip)
```

So **every slip loses money on average**, and no choice of games, markets or flips changes that.
Missing one leg out of 100 is still a total loss, because an accumulator pays only when every leg lands.
What an algorithm *can* change is the **shape** of the outcome: how often you win, how much a win pays,
and how the slips overlap.

### The identity that drives everything

A slip either pays `payout` or nothing, so its expected return is `P(win) × payout = keep × stake`. Hence:

```
P(slip wins) = keep × stake / payout
```

With the payout pinned to a target `T`, **every slip that pays ≈ T wins with probability ≈ keep × stake / T**.
Picking "smarter" games cannot move that number except through `keep`, which is lower-margin legs plus
the bonus. And for a family of K slips:

```
P(≥1 slip wins) ≤ Σ P(slip_i wins) ≈ K × keep × stake / T        (equality when no two slips can win together)
```

At your example scale (₦1,000 budget, ₦10 stake, ₦100,000 target): `100 × 0.75 × 10 / 100,000 ≈ 0.75%`.
That is the **ceiling for any algorithm** at that budget and target, however clever. The only ways to
raise it are to spend more, lower the target, or improve keep.

---

## 2. How the algorithm evolved in the code

| Version (when) | What it built | What we measured | Where |
|---|---|---|---|
| **PEDLAS v1–v2** (Jun 14–28) | Pick N fixtures, enumerate Over/Under outcome **vectors**, rank by probability, fill the budget top-down. Goal-prediction models advised which games to use. | Every model **backtested negative** on every market. Kept as advisory only. | `pedlas_v1.md`, `pedlas_v2.md`, `lib/pedlas/predict.ts` |
| **PEDLA v1** (Jul 16) | **Under 4.5 only**, odds ≥ 1.20 (the bonus gate), quality-picked legs, multi-book adapters. | The simplest honest anchor (Under 4.5 lands ~84% of the time). | `pedla_v1.md`, `lib/pedlas/build-book.ts` |
| **v3 coverage** (Jul 16) | K = budget ÷ stake slips; safe games in every slip, risky games *dropped* in diversified patterns. First correlated simulator. | Over 4.5 ("cutters") ≈ 19% per game and **correlated** (var/mean ≈ 1.7). Coverage ≠ profit. | `pedlas_v3.md`, `lib/pedlas/coverage.ts` |
| **Flip-scatter / covering design** (Jul 17) | Base = all-Under slip reaching the target; other slips **flip** legs to Over, layer by layer (all 1-flips, all 2-flips…). Guarantee: if ≤ m eligible games go Over, one slip matches. | Guarantee is conditional on "locked" games holding. | `buildFlipScatter` |
| **Realizer** (Jul 18) | Simulate 40k correlated days; cover the **K most frequent** realistic outcome patterns. | "Already P(win)-optimal" for its model; history blending *lowered* P(win). | `buildRealizer`, `optimum-plan.md §10–11` |
| **Multi-line anchors** (Jul 19) | Best dominant anchor per game across all total lines (Over 1.5, Under 3.5…). | **Worse**: the 1.20 gate forces ~72%-reliable anchors. Off by default. | `market_policy: 'multi_line'` |
| **Real SportyBet bonus** (Jul 19) | Captured the Multi Bet Bonus from live betslips (9 legs +30%, 20 +92%, 35 +231%). | The only change that improved every build (fewer legs to reach the target). | `lib/books/sportybet.ts` |
| **Multi-market 3-band** (Jul 20) | Each game = LOW (0–2) / MID (3–4) / HIGH (5+). Four markets: U2.5, U4.5, O2.5, O4.5. One slip per sampled "plausible day", legs trimmed to the target. | Became the default. This is the first step toward the scoreline idea in §4. | `lib/pedlas/multi-market.ts` |
| **Today (Sep 25)** | Greedy max-coverage selection; win chance **priced like the book**; history gate enforced; site-confirmed amounts. | See below. | this change set |

### What today's change set fixed in the maths

- **The reported win chance was inflated.** It came from a correlated simulation (fixed ρ = 0.15) that
  implicitly assumes the bookmaker underprices accumulators. Checked against the identity in §1:

  | ₦ budget → target | reported before | book-consistent ceiling | now reported |
  |---|---:|---:|---:|
  | 1,000 → 100,000 | 3.5% | 0.57% | **0.54%** |
  | 5,000 → 500,000 | 3.2% | 0.50% | **0.41%** |
  | 10,000 → 60,000 | 15.6% | 9.3% | **7.5%** |

  A 3.5% chance of winning ≥ ₦100k on ₦1,000 would mean an expected return ≥ ₦3,500, which is +250% EV.
  The bookmaker's own prices rule that out. The correlated figure is now shown only as a labelled
  **stress figure** on the session's Risk tab.
- **Selection:** the old sampler picked one random plausible day per slip. It is replaced by **greedy
  coverage**: each slip is the candidate that wins on the most days not already covered. Same budget,
  book-consistent pricing: ₦1k → ₦100k **0.19% → 0.54%**, returns per ₦100 **₦58 → ₦73**.
- **History gate:** `require_history` was silently ignored by the default engine. It is now enforced.
  If too few games have history, the build refuses and gives the numbers.

---

## 3. The real record (from the database, 2026-09-25)

| | |
|---|---|
| Real slips placed | **2,098** (₦20,980 staked) |
| Settled | 1,113, all lost; **0 won** |
| Net on settled slips | **−₦11,130** |
| Still unsettled | 985 slips, games finished in July. Press **Results → Settle finished games** |

This is consistent with the honest numbers in §2: sessions that each had well under a 10% chance of
producing any winning slip, and none did. It is not evidence of bad luck beyond what the prices predicted.

---

## 4. The Decision Bot: what you proposed, stated precisely

**Goal.** Given a budget `B`, a stake `s` and a target `T`, build `K = B ÷ s` slips, one after another.
Each slip pays **between T and 1.01·T** (bonus included) if it wins. Every choice the bot makes is logged
with its reason. The bot is *predictable*, because the same seed gives the same slips and the same log,
yet *unpredictable* in what it picks, because choices are random within the rules.

### 4.1 Game order (fixed, used everywhere from build to results)

```
sort games by: 1) kickoff time   2) length of "Home vs Away" (shortest first)   3) A→Z
```

Rule 3 is added because two games can kick off together with names of equal length. Without a final
tie-break the order would not always be identical. Live example (all three are Premier League games on Oct 10):

1. Arsenal vs Leeds United (11:30)
2. Chelsea vs Bournemouth (14:00, 22 characters)
3. Ipswich Town vs Fulham (14:00, 22 characters, tie broken A→Z)

### 4.2 The selection catalogue: two-sided markets and their flips

Every selection has exactly one **flip**, which wins on precisely the scorelines where it loses. Using
only pairs like this makes "flip" well defined, and means the two sides of a pair split the game's
outcomes between them with nothing left over.

| Pair | Selection ↔ flip | Notes |
|---|---|---|
| 1X2 | Home ↔ Draw-or-Away · Away ↔ Home-or-Draw · Draw ↔ Home-or-Away | 3-way market; its flip is the matching Double Chance |
| Total goals | Over L ↔ Under L, L = 0.5 … 5.5 | half-lines only (whole lines can refund) |
| Both teams score | Yes ↔ No | |
| Odd/Even | Odd ↔ Even | |
| Clean sheet | Home CS Yes ↔ No · Away CS Yes ↔ No | **[dropped 2026-10-02]** worst margin of any market (§0.5) |
| Team totals | Home Over L ↔ Under L · Away Over L ↔ Under L | |

That gives **38 selections per game** in the live example (19 pairs). Excluded: Draw No Bet and
whole-line handicaps (can refund). **[corrected, see §0]** A selection **below 1.20** does not count toward the bonus
(it does not break it for the whole slip, as first written); about 20% of selections, e.g. Over 0.5 @ 1.02.
**One selection per game per slip**: combining two markets from the same game is a different product
(Bet Builder) with adjusted odds.

### 4.3 The scoreline table: what each selection covers

A game ends on one scoreline, and each selection is **the set of scorelines it wins on**. Arsenal vs
Leeds, with the table fitted to the book's prices (expected goals 2.04 vs 0.80):

| score | P | Under 4.5 | Over 1.5 | Both score | Even | Home win |
|---|---:|:-:|:-:|:-:|:-:|:-:|
| 2-0 | 12.2% | ✓ | ✓ | · | ✓ | ✓ |
| 1-0 | 11.9% | ✓ | · | · | · | ✓ |
| 2-1 | 9.7% | ✓ | ✓ | ✓ | · | ✓ |
| 1-1 | 9.5% | ✓ | ✓ | ✓ | ✓ | · |
| 3-0 | 8.3% | ✓ | ✓ | · | · | ✓ |
| 3-1 | 6.6% | ✓ | ✓ | ✓ | ✓ | ✓ |
| 0-0 | 5.8% | ✓ | · | · | ✓ | · |

`P(selection) = Σ P(scorelines it covers)`. This is how different markets on the same game are
compared on one scale, and how the bot knows that "Under 4.5" and "Over 1.5" overlap on 2-0, 2-1, 1-1, 3-0 …
while "Both score: Yes" and "Home clean sheet: Yes" never do.

### 4.4 Building one slip (target-driven)

```
payout = s × (1 + bonus(legs)) × Π odds
for game in ORDER:
    choose a selection for this game          ← decision rule (§4.5), logged
    if payout ≥ T: stop                       ← "stop adding games when the amount reaches the target"
closing step: the last leg is chosen from the options that put payout inside [T, 1.01·T];
              if none does, re-choose the previous leg (backtrack one step), logged as such.
```

The band matters: every winning slip pays ≈ T, never a surprise ₦3M. Per the identity in §1, that also
makes every slip's win chance ≈ `keep × s / T`.

### 4.5 Decision rules (the "brain"), each logged

| Rule | How it picks | Log line (reason) |
|---|---|---|
| **random** | seeded uniform among allowed options | `random (u=0.012) among 130 in-band combos` |
| **flip** | slip 1 random; later slips flip as many of slip 1's picks as the band allows | `flips 1/3 of slip 1's picks, still in band` |
| **greedy** | the option or slip that adds the most *new* winning scorelines to the family | `adds +4.77% to P(≥1 win)` |
| weighted-random *(suggested)* | random, weighted by P(selection) | `weighted random (u=…, p=…)` |

Log format, one JSON line per decision, stored with the session:

```json
{"slip":2,"game":1,"match":"Arsenal vs Leeds United","pick":"Total goals Even","odds":1.90,
 "alternatives":37,"rule":"greedy","reason":"adds +4.77% to P(≥1 win)","payoutSoFar":19.0,"seed":7}
```

### 4.6 The search space

38 selections per game means **38ᴺ combinations**: 54,872 for 3 games, but about **3×10²⁰** for the
~13 games a ₦100k target needs. That cannot be enumerated, which is why the bot builds one leg at a time
and only searches the last one or two legs to land in the band. For 3 games we *can* enumerate, which is
the worked example.

---

## 5. Worked example: live odds, 3 games, ₦10 stake, target ₦200

| Step | Count |
|---|---:|
| All combinations (38 × 38 × 38) | 54,872 |
| Every leg ≥ 1.20 (bonus-eligible) | 30,624 |
| Paying **₦200–₦202** (3-leg bonus 5%) | **130** |
| Win chance of each of those 130 | 2.9%–5.2% (≈ keep × 10 / 200) |

Five slips (₦50) from those 130, seed 7:

| Rule | P(≥1 of 5 wins) | Expected return on ₦50 | Returns per ₦100 |
|---|---:|---:|---:|
| random | 18.4% | ₦41.1 | ₦82 |
| flip | 18.8% | ₦44.9 | ₦90 |
| **greedy** | **22.8%** | ₦46.9 | ₦94 |

Greedy's log:

```
slip 1: G1 Away win @7.39 · G2 Total goals Odd @1.96 · G3 Home or Away @1.32 → ₦200.75, wins 5.15%
slip 2: G1 Total goals Even @1.90 · G2 Away win @4.00 · G3 Away win @2.53   → ₦201.89, adds +4.77%
slip 3: G1 Draw @4.89 · G2 Home win @1.82 · G3 Away Over 1.5 @2.15           → ₦200.91, adds +4.61%
slip 4: G1 Away Under 0.5 @2.05 · G2 Away Under 0.5 @3.40 · G3 Home win @2.76 → ₦201.99, adds +4.20%
slip 5: G1 Away Over 1.5 @4.90 · G2 Total goals Even @1.86 · G3 Under 2.5 @2.10 → ₦200.96, adds +4.10%
```

What the example shows:

- **Your band idea works mechanically.** 130 of 54,872 combinations pay exactly ~T, and a seeded bot can
  pick among them reproducibly, with a readable reason for each pick.
- **Pure flipping is not the strongest rule.** A strict flip of slip 1 usually leaves the band (the
  flipped odds differ), so "flip" degrades to "flip one leg". Greedy coverage wins because it chooses slips
  whose winning scorelines *don't overlap*.
- **The ceiling is visible.** All 130 in-band slips together (₦1,300) win 88.6% of the time, and every
  win pays about ₦200. Covering nearly everything guarantees a loss; this is the "variance dial, not a
  profit dial" from `docs/learnings.md §3`.

**A warning the example exposed.** The simple (independent-Poisson) scoreline table disagrees with the
book on some markets. It rates "Chelsea vs Bournemouth: Away win @ 4.00" at keep 1.022, which looks like
an edge but is model error (independent Poisson under-rates draws). Greedy happily chases such errors,
which is why its 0.94 above is flattered. The real build **must calibrate the table so every selection's
probability matches the book's de-vigged price** (fit to all markets at once, not just four). Otherwise
the bot optimises for our modelling mistakes.

---

## 6. Honest EV at your real scale

Margins seen live (two-sided, so keep per leg ≈ 1/(1+m)):

| Market | margin | keep/leg |
|---|---:|---:|
| 1X2 / Double Chance | 3.6–7.0% | 0.93–0.97 |
| Total goals | 5.5–6.5% | ≈ 0.94 |
| Both score | 4.3–5.2% | ≈ 0.95 |
| Odd/Even | 4.8–5.0% | ≈ 0.95 |
| Clean sheet | 6.5–7.3% | ≈ 0.94 |
| Team totals | 4.6–5.4% | ≈ 0.95 |

₦1,000 budget, ₦10 stake, ₦100,000 target → odds × bonus ≈ 10,000 → about 13 legs at average odds ~1.9:

```
keep ≈ 0.95^13 × (1 + 0.48 bonus) ≈ 0.51 × 1.48 ≈ 0.76
P(one slip wins) ≈ 0.76 × 10 / 100,000 ≈ 0.0076%     (about 1 in 13,000)
P(≥1 of 100 slips) ≤ 0.76%                           (reached only if no two slips can win together)
expected result ≈ −₦240 per ₦1,000 session
```

- **What the Decision Bot can do:** exact payout control (every win ≈ T), every decision explained and
  reproducible, access to lower-margin markets (1X2 favourites and BTTS at 4–5% beat Over/Under at ~6%,
  which raises keep), and near-zero overlap between slips (pushes P(≥1) toward the ceiling).
- **What it can't do:** make any slip, or the family, +EV; or beat the ceiling `K × keep × stake / T`.
- **Where an edge could come from:** only a price sharper than SportyBet's (line-shopping against a sharp
  book), as recorded in `pedlas-no-model-edge`. Nothing inside SportyBet's own odds creates it.

---

## 7. Proposed build (after we agree §8) — built, see §0

1. **Market catalogue.** Adapter pulls markets 1, 10, 18, 19, 20, 26, 29, 31, 32 and builds the 19 flip
   pairs per game, applying the ≥ 1.20 filter. Placement: booking codes already support any
   `marketId/specifier/outcomeId`.
2. **Calibrated scoreline table** per game. Fit so every selection's P matches its de-vigged price
   (tolerance ≤ 1pt), with a unit test that no selection shows keep > 1.
3. **Decision Bot** (`lib/pedlas/decision-bot.ts`): ordering, sequential target-driven build, band
   closing and backtrack, rules (random / flip / weighted / greedy), seed, JSON decision log.
4. **Scoring** stays book-consistent: independent games; the correlated figure only as a stress number.
5. **UI:** a "Decisions" tab on the session showing the log per slip (why each leg was chosen).
6. **Settlement** works unchanged: legs carry market / specifier / side and settle from final scores.
   New markets (1X2, BTTS, odd/even, clean sheets, team totals) need their settle rule, which is a
   predicate on (home, away) as in §4.3.

## 8. Decisions needed from you — answered, see §0

1. **Band width:** 1% (₦100k–₦101k) as you said? A tighter band means fewer candidate slips and more backtracking.
2. **Default rule:** greedy (best P(≥1)), weighted-random (unpredictable, near-best), or your pure random/flip?
   The example: greedy 22.8% vs random 18.4% for the same ₦50.
3. **Markets:** all 19 pairs, or leave out ones you don't trust (e.g. Odd/Even, whose outcome is close to a coin flip)?
4. **Legs below 1.20:** exclude (keeps the bonus, current rule) or allow (and lose the bonus on that slip)?
5. **History:** H2H stays a *gate* (only games with history), per your standing rule. Should it also
   *weight* choices? Past measurements say weighting lowers P(win) (`realizer-already-optimal`).

# Near-miss products: getting money back when slips lose

Status: **built** (2026-10-02): builder, session option, placer, settlement and UI, with a dry run on the real betslip (`algorithm_v1.md` §0.7). Not yet staked. The question: can SportyBet's near-miss
products return a meaningful amount of the budget on a losing day, while keeping a shot at the jackpot?

Everything below is grounded in SportyBet's own code and in our own slips:

- **Formulas:** decoded from the betslip's own code. `lib/books/sportybet-flexi.ts` reproduces a real
  betslip to the kobo, and the test in `__tests__/lib/books/sportybet-flexi.test.ts` locks that in.
- **Data:** every placed Decision Bot slip (399 slips, 7 sessions) and its real results.
- **Re-runnable study:** `npx tsx scripts/flexi-study.ts`.

## 1. The products, exactly

**Flexibet: "at least k of N correct".** No Multi Bet Bonus.

```
F    = P(at least k of the N legs win)       SportyBet's own outcome probabilities, legs independent
L    = max(0.8, Σ odds²·p ÷ Σ odds)          the legs' odds-weighted return (≈ 0.95 in practice)
key  = min(L, F^(1 − L))
odds = key ÷ F                               payout = stake × odds, capped at the site's max win
```

`key` is the return per ₦1 staked, assuming SportyBet's probabilities are fair. Two consequences:

- **Loose tickets keep almost a single leg's return** (0.95 or more): the key stays at L while
  F ≥ L^(1/(1−L)), which is about 0.36.
- **Tight tickets pay less back:** the key shrinks as F^(1−L). At a ₦51k target from ₦10 it falls to
  about 0.67, worse than a plain accumulator with the bonus (about 0.82).

**One Cut.** A plain accumulator (with its bonus) on part of the stake, plus a Flexi "N−1 of N" on the
rest, sold as one ticket. The split is set by a slider (1–99%) or by a default:

```
d = (odds × S + bonus) ÷ S
default cut stake p = max(S/A, S·(A−1)/(d+A−2))      A = Flexi(N−1) odds
one leg lost → A·p            all win → d·(S−p) + A·p
```

**Verified on a real betslip** (8 × Under 2.5, ₦100; booking code G0JEDL, loaded and read, never
placed):

| Ticket | Site | Formula |
|---|---:|---:|
| Flexi 8 / 7+ / 6+ / 5+ / 4+ of 8 | 49,578.37 / 4,926.08 / 1,052.69 / 367.88 / 183.62 | identical |
| One Cut at the 99% slider: all win / one cut | 5,410.80 / 4,876.82 | identical |

## 2. What it would have done with our slips

**Real results.** 117 of our slips have every game finished (₦1,170 staked).

- **Legs missed:** 2 missed on 4 slips, 3 missed on 18, 4 or more missed on the rest.
- **What each product would have paid:**

| Product on the same slips | Returned | Tickets paid |
|---|---:|---:|
| Plain (what we placed) | ₦0 | 0 |
| One Cut, Flexi N−1 | ₦0 | 0 |
| Flexi N−2 | ₦733 (63%) | 4 |
| Flexi N−3 | ₦1,361 (116%) | 22 |

- **All 399 slips, including those with games still to play:** 375 are already lost as plain,
  300 as N−1, 217 as N−2 and 145 as N−3.

**Simulated:** the same 399 slips (₦3,990), 20,000 days. Leg probabilities are book-honest (see §4),
so no product can look better than SportyBet prices it.

| Strategy | Back per ₦1 | ≥ budget back | ≥ half back | ₦50k+ jackpot | Median back |
|---|---:|---:|---:|---:|---:|
| Every slip plain (today) | 0.818 | 5.9% | 6.5% | **4.14%** | ₦0 |
| Every slip One Cut | 0.818 | 5.9% | 6.5% | 2.04% | ₦96 |
| Every slip Flexi N−1 | 0.816 | 32.6% | 58.6% | 0% | ₦2,679 |
| Every slip Flexi N−2 | 0.888 | 31.7% | 93.4% | 0% | ₦3,425 |
| Every slip Flexi N−3 | 0.939 | 31.0% | **100%** | 0% | ₦3,719 |
| 90% plain + 10% floor layer | 0.833 | 5.4% | 5.7% | 4.18% | ₦386 |
| 75% plain + 25% floor layer | 0.830 | 4.4% | 5.0% | 3.82% | ₦962 |
| 50% plain + 50% floor layer | 0.866 | 3.0% | 39.6% | 2.88% | ₦1,918 |

**The floor layer.** These are Flexi tickets on *likely* legs: the most probable pick per game with
odds ≥ 1.20 (average P 70%), 8 legs, at the tightest k that still wins at least 45% of the time.

- **Price:** each returns about ₦0.935 per ₦1 and pays about 1.6× its stake when it lands.
- **Real results:** 400 such tickets on 55 finished games returned **₦3,559 of ₦4,000 (89%)**, and
  255 paid. With 55 games they share legs heavily, so that real sample is noisy.

Back-per-₦1 figures for the plain-heavy mixes carry about ±0.02 of simulation noise: the plain part's
average is dominated by rare jackpot days.

## 3. What this means

1. **Nothing gets the whole budget back more often.** Every product returns less than ₦1 per ₦1, so
   only a jackpot clears the budget. "≥ budget back" only *falls* as money moves from jackpot slips to
   the floor.
2. **What a floor buys is a typical day that returns a share instead of nothing.** With a floor share
   f, a losing day returns about 0.93 × f × budget. The jackpot chance falls roughly in proportion
   to (1 − f), and the expected loss gets smaller.
3. **One Cut is not worth it for us.** At the default split it halves the jackpot chance and adds
   nothing: our slips almost never miss by exactly one leg (0 of 117).
4. **Converting jackpot slips to Flexi N−3 is a worse floor than a dedicated one.** Each converted slip
   pays little (about ₦30–110), and the jackpot share it gives up is the same.

## 4. Honesty notes

- **Long shots are overstated in our model.** Our stored leg P comes from the fitted scoreline table,
  which overstates big underdogs: 14% of legs had odds × P above 1, up to 1.40 on a "Home win @ 26".
  Uncapped, Flexi's odds-weighted formula turned that error into a fake 0.99 return. The study caps
  odds × P at 0.97 (SportyBet's own probabilities sat at 0.94–0.97 on the probe legs).
- **The same issue affects the Decision Bot.** It ranks legs by these probabilities, so it may lean
  towards long shots. Separate follow-up: use each leg's de-vigged price for its P, and keep the table
  only for overlaps between picks.
- **Pricing probabilities are approximate.** SportyBet prices Flexi off its own probabilities, which we
  don't store. Live builds should read them from the feed (the `probability` field, already parsed by
  `selections.ts`).

## 5. Proposed build (after we agree the split)

1. **Builder (`lib/pedlas/floor.ts`).** Given a floor budget, pick likely legs (odds ≥ 1.20, lowest
   margin) on games not used by jackpot slips. Use fresh legs, so the floor doesn't die with the
   jackpot slips. Size 8-leg tickets at the tightest k with P ≥ 0.45, priced with `flexiOdds` on the
   feed's own probabilities.
2. **Session and UI.**
   - A **floor share** control on New session (0 / 10 / 25 / 50%), showing the live trade-off from
     this study: jackpot chance, median back and expected loss.
   - Floor tickets stored as slips with `product: 'flexi'` and their `k`.
3. **Placer.** Load the code, switch the betslip to Flexi, set k through the betslip's own selector,
   then **verify the Potential Win against `flexiOdds` before Confirm**, as we already do for the
   payout. Flexi carries no bonus, so the bonus check is skipped for these tickets.
4. **Settlement and the Survival tab.** Settle Flexi tickets with "at least k correct", and count the
   floor in the chance and budget figures.

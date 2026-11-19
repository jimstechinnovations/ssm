# Claude Strategy Chat — Full Context for This Project

This file exists so that anyone who receives this `ssm` folder can understand everything the owner and Claude have worked out together about how betting slips get built here. It is not a transcript — it's the distilled methodology, rules, and history behind every script in `scripts/`. Read this before touching any `cook-*.mjs` / `build-*.mjs` / `tmp-*.mjs` file.

**Important framing:** nothing here is a guarantee. This is a risk-management process for picking which bets to put together, built up over months of trial and error on a real account. It never guarantees wins — several slips documented below lost despite being built "correctly." The point of the process is picking defensibly, not picking infallibly.

---

## 1. What this project is

The `ssm` repo (internally called **PEDLA**) is a personal multi-sport, multi-book sports-betting slip builder, used against a **SportyBet Nigeria (NG)** account by someone based in **Rwanda (CAT timezone, UTC+2)** — note the account is NG but the user's local time is CAT, NOT WAT (UTC+1), which matters for every kickoff time shown.

- Core engine: `lib/pedlas/`
- UI: `app/pedlas/`
- Everything else: `scripts/` — dozens of one-off and reusable Node scripts that:
  1. Pull live/upcoming odds from SportyBet's own API (`factsCenter/pcUpcomingEvents`, `factsCenter/liveOrPrematchEvents`, `factsCenter/event`)
  2. Build a candidate pool of games + markets, filtered and ranked by de-vigged true probability
  3. Generate a shareable **booking code** via `POST /api/ng/orders/share` (this previews a slip without placing real money — nothing in this workflow stakes money automatically; only the user decides to actually place a code in the app)
  4. Verify every leg actually booked (`bookingStatus === 'Booked'`) before handing a code to the user
  5. Later, check results against final/live scores via the same `factsCenter/event` endpoint

Nothing here places real bets automatically. Claude's job is: build the candidate pool → pick the safest legs → generate and verify a booking code → report it with odds and true probability → optionally check results later. The user decides whether to actually place it.

---

## 2. SportyBet market-ID catalog (mapped by hand, confirmed via API probing)

### Football (sportId `sr:sport:1`)
| ID | Market | Notes |
|---|---|---|
| 1 | 1X2 (moneyline) | Home/Draw/Away. **Never used as a straight pick** — see rule below. |
| 10 | Double Chance (DC) | Home-or-Draw / Draw-or-Away / Home-or-Away. De-prioritized — see rule below. |
| 11 | Draw No Bet (DNB) | |
| 16 | Handicap | Scan every offered line, take the deepest one clearing the odds floor. |
| 18 | Over/Under total goals | Specifier `total=X.5`. The main goals market. |
| 19 | **Home team's own** Over/Under goals | e.g. `total=0.5` → home team scores ≥1, regardless of the away team. |
| 20 | **Away team's own** Over/Under goals | Same idea, for the away side. |
| 29 | GG/NG (BTTS — Both Teams To Score) | Yes/No. Distinct from markets 19/20 — do not confuse "team scores Over 0.5" with BTTS. |
| 30 | Which Team To Score | None / Only Home / Only Away / Both — discovered, rarely used. |
| 60-98 range | 1st/2nd half variants | e.g. 69/70 = 1H Home/Away O/U; 91/92 = 2H Home/Away Team Total; 68 = 1H O/U |
| 60110 | DC 1UP (early payout) | Pays the instant your side ever leads by the DC condition — settles mid-match, not on final score. See the settlement gotcha in §5. |
| 60100 / 60200 | 1X2 1UP / 2UP | Settles as a win once that team takes a 1- or 2-goal lead; used as a straight-win substitute. |
| 105 | 10-Minute 1X2 | Shortest interval product SportyBet NG offers — there is no 5-minute market. |

### Basketball (sportId `sr:sport:2`)
| ID | Market |
|---|---|
| 225 | Over/Under total points |

### Tennis (sportId `sr:sport:5`)
Live 1st-set market used in `cook-tennis-1stset-slip.mjs`. Not fully built out yet (see §7).

### Other sports identified on the platform (not yet built into this repo's tooling)
3 = baseball, 4 = ice hockey, 6 = handball, 10/20 = table tennis, 12 = rugby, 16 (overloaded — this is American football/NCAA football under a different sport context), 19 = snooker, 21 = cricket, 22 = darts, 23 = volleyball.

### Hard platform limit
**SportyBet caps total slip payout at 1000x**, confirmed live — a code whose legs mathematically multiplied to ~28.8 million still displayed/paid as 1000x in the real app. For any "uncapped"/huge-multiplier request: legs added after the running product crosses ~1000x are pure added risk for zero extra payout. Sort safest-first and stop there regardless of how many fixtures remain in the pool.

---

## 3. The core build method (validated, default for every "make me a slip" request)

1. **Pull the pool** for the requested window (today / tonight / a named day / live-in-play), always applying a **60-minute kickoff buffer** (`minK = now + 60min`) so nothing about to go suspended sneaks in.
2. **Filter out structurally risky leagues/competitions** using a standing regex (grown over time):
   ```
   /^J2 League$|^J3 League$|Serie C|Eerste Divisie|Liga de Expansion|^Ettan$|A-League, Women|Eredivisie, Women|Super League( 2)?, Women|Tercera Federacion|Promotion d.Honneur|^2\. Liga$|Primera Division, Women|Premier League, Women|U20|U19|U21|Reserves?|Premier League Cup/
   ```
   These leagues/divisions are either known low-scoring/defensive (J2/J3 Japan — see incident in §5), thin on public data, or structurally unreliable (youth/reserve sides).
3. **Rank every remaining game's qualifying market(s) by de-vigged true probability**, not raw bookmaker odds.
4. **Check actual recent form/scoring stats** for any Over/Under total pick — football goals OR basketball points — before trusting the odds feed. This is not optional for goals/points markets (see §5, incident list — this rule exists because odds-only picking has caused real, repeated losses).
5. **Greedy-fill legs, safest-first, until the target combined odds is reached.** Don't over-add once the target named teams/legs already hit it.
6. **Generate the booking code** (`POST /orders/share`) and check every outcome's `bookingStatus`. Drop and replace any leg that comes back not `Booked` — never hand over a code with a dead leg.
7. **Re-verify a second time** after rebuilding, to catch anything that went stale between the first check and final delivery (live odds and availability move fast, especially same-day).
8. **Always report the combined true probability** (product of each leg's devigged probability) alongside the combined odds — never just the multiplier. Compounding legs makes even high-per-leg-probability slips look very different in aggregate (e.g. 30 legs at ~90% each is still only ~4% combined).
9. **Always show each leg's kickoff date and time, converted to CAT (UTC+2)** — never WAT, never raw UTC, in every table or list, not just the final slip.

---

## 4. Standing rules (current state — some of these flipped over time, history kept below so nobody re-litigates a settled argument)

- **No straight 1X2 win picks, ever.** User: *"i dont do straight wins."* Use Double Chance, 1X2/DC 1UP (settles early on a lead), or an Over/Under goals line instead. Exception carved out for **live in-play** slips: a straight win is allowed only when the leg is already a "comfortable" lead (2+ goal margin, or a 1-goal margin held past the 75th minute) — otherwise even live-market straight wins are replaced with Over/Under.
- **No Double Chance as the default safe market.** User: *"i dont like this double chance... i like goals."* DC isn't banned outright, just no longer the default — prefer Over/Under total goals (market 18) first, team Over 0.5 (19/20) as a reasonable secondary goals-family option.
- **Under 4.5 is banned outright.** Use **Under 3.5 only**, keep Under slips to a moderate ~6 games rather than maxing leg count. (History: de-weighted 2026-10-05 → banned outright 2026-10-12 after repeated busts even when both book odds AND the form model agreed it was safe → briefly un-banned 2026-11-09 by explicit user request → the Nov-09 reversal was confirmed *permanent* when asked. **Current state: banned again** per the most recent explicit instruction — always confirm which state is current before trusting this summary if it's been a while.)
- **Always check recent scoring form/pace before any Over/Under total pick** (goals or basketball points) — never odds alone. This applies doubly to: youth/U19/lower-profile national teams, lower-tier/lower-division leagues (J3/J2 Japan, Brazilian Série B, etc. — known low-scoring or poorly-tracked), and basketball mismatches between a major program and a small/slow mid-major (pace mismatches skew the posted total toward the wrong team's tempo).
- **"No data found" on a lower-tier leg is a yellow flag, not a pass.** It happened that two legs with zero trackable history both busted a 100x slip once the pool got stretched — treat data gaps as added risk, not neutral, especially as leg count grows.
- **Variance is not automatically a process failure.** A single bad leg in a large, correctly-built combo can just be bad luck — the user has explicitly said this and does not want over-cautious new restrictions bolted on after every normal loss. Diagnose root cause when asked (did we miss a checkable signal, or did the game just go the other way), but don't reflexively tighten the process after every loss.
- **Always verify booking status before delivering a code**, and **always state combined true probability**, not just odds (see §3).
- **5-sport roster, as of 2026-11-19:** Football, Basketball, Tennis, Cricket, Volleyball (ranked by how built-out the tooling is — football and basketball are fully mapped, tennis partially, cricket/volleyball not yet built). The user may explicitly ask to **mix sports within one slip** as a deliberate risk-diversification tactic, not just for variety.
- **Weekday vs weekend cadence, as of 2026-11-19:** Weekends are the heavy slip-building period — build freely across the full sport roster. Weekdays are lower-volume by default — check pool depth/quality across the sports FIRST, and say plainly if it's not worth building rather than forcing a weaker slip through on a thin day.
- **The mixed Over 1.5 / favorite's-own-Over-0.5 strategy** (paused mid-week 2026-11-18, to resume when weekend domestic games return): for mismatched fixtures where the stronger side might grind out a narrow win rather than open the game up, judge per-game whether to bet match-level Over 1.5 (market 18) or just the favorite's own Over 0.5 (market 19/20, whichever side has the shorter moneyline odds). Not a blanket swap — a per-game read. Still skip the leg entirely (don't fall back to the other side) if the favorite's own market isn't active, and require ≥75% probability on the Over 0.5 pick specifically.

---

## 5. Lessons learned from real incidents (why the rules above exist)

- **BTTS slip, pre-Sept 2026**: a leg generated a booking code but came back `Unavailable` on the suspended market — this is why booking status gets verified every single time now, not just trusted from the code generation step.
- **LDU Quito vs Palmeiras, Under 4.5, ~Sept 2026**: picked at 93% pre-match purely on odds; went 1-1 inside 17 minutes. User: *"next time dont trust on just odds let include life scenario and statistics."* This is the origin of the whole "check form, not just odds" rule.
- **Stale-data trap**: a naive history fetch once returned one team's results from 16 months earlier while the opponent's were current, producing a confident-looking but fabricated "edge" in a model (a false +51.6pt edge on an Atlético–Real derby). A staleness guard (reject history older than 45 days) was added — a wrong-looking stat is worse than no stat, because it's more persuasive while being false.
- **50-leg slip `R4MNPR`**: 44/49 decided legs landed correctly (one voided) — almost exactly the predicted per-leg probability. The accumulator still lost outright (50-leg parlays need every leg right), but this confirmed the *picking* method itself works; giant-combo failure is structural math, not a sign the selection process is broken.
- **Augsburg–Bayern 2-2 and Sakaryaspor–İskenderun 2-2**: both busted odds-only Double Chance "Home-or-Away" picks. Home-or-Away is the *only* DC variant that loses on any draw (including a wild high-scoring one) — Home-or-Draw/Draw-or-Away survive a draw. Book price tends to understate draw risk in competitive lower-tier matchups with no clear favorite.
- **Pyramids FC 4-1 Ceramica Cleopatra**: an Under 4.5 pick priced 88% by the book AND independently confirmed ~87% by a recency-weighted form model — both signals agreed, and it still busted. This is why Under 4.5 eventually got banned outright rather than just de-weighted — it kept breaking even with good signals behind it.
- **Fukushima United 1-0 SC Sagamihara (Japan J3 League)**: an 82%-implied Over 1.5 pick was the lone loss that killed an otherwise-correct 50-leg/3000x combo. J3 is a notoriously low-scoring third division; this is why lower-division leagues get extra skepticism on goals markets regardless of how good the price looks.
- **Indiana Hoosiers vs Tennessee Tech, basketball**: an Over 160.5 pick at 68% implied probability missed because the total was built around the stronger team's tempo, not the slower mid-major opponent's — the same pace-mismatch problem exists in basketball as in football, and there's no dedicated pace/box-score tool for it yet (an acknowledged gap).
- **Ireland vs Greece (U19)**: Over 1.5 at 74% implied probability finished 0-0 — youth internationals are small-sample and often defensively cagey; another reason U19/U20 is in the risky-league filter.
- **2026-11-17/18 session (this week)**: multiple 10x/20x/50x football slips, several basketball 10x/20x slips, and a risky football-only high-odds combo (2150x) were all built, verified, and then **lost** on specific identifiable legs once results came in — documented in detail in chat but not reproduced line-by-line here. The pattern repeats: well-vetted legs mostly hold, but any multi-leg combo is only as strong as its weakest leg, and lower-tier/cup fixtures with thin searchable data are consistently the riskiest category even after exclusion passes.
- **2026-11-18/19 basketball slips (UX7BV9 10x, HN5QDM 20x)**: built with full injury/rest-news checks on NBA/Euroleague legs and actual scoring-stat verification on NCAA mismatch candidates. Result: 6 wins, 1 loss (Miami Heat vs Bucks, Under 249.5, finished 137-130 — a high-scoring night the pre-game data didn't flag), rest pending/trending well at last check. Confirms the process reduces but never eliminates risk — a well-vetted pick still has its real failure rate baked in (a ~77% pick loses roughly 1 time in 4).

---

## 6. Framing that matters when reporting results to the user

- A bigger candidate pool lets you **cherry-pick safer legs**, which is a real, quantifiable improvement (e.g. one night's top-30-by-probability legs averaged 89.8% each vs. 71.9% for the bottom 30 in the same pool — a combined-probability gap of 3.9% vs. 0.005%). But it does **not** turn a 30-leg combo into a likely win — multiplying that many probabilities together is still a long shot by construction, even with the best legs available anywhere.
- State the combined true probability every time, plainly, next to the odds.
- When a well-built slip loses, give a brief factual note on what happened (which leg, what the actual score/stat was) and move on — don't over-apologize, and don't treat it as proof the method is broken unless there's an actual checkable signal that was missed.

---

## 7. Open gaps / things not yet built

- No dedicated basketball pace/box-score tool exists yet (form-checking basketball relies on manual web search per leg, not an automated model the way football has `lib-history.mjs`/`h2h-probe.mjs`).
- Tennis tooling is partial — only a live 1st-set script exists; no market-ID risk filter or form-check workflow built out yet, and lower-tier tennis (ITF/Challenger) carries a documented match-fixing/integrity risk that should keep it restricted to tour-level (ATP/WTA) fixtures once built out properly.
- Cricket and volleyball have no tooling at all yet — picked as roster sport #4 and #5 because SportyBet NG has reasonable market depth on them and both have no-draw outcomes, but the market-ID catalog and risk filters for them still need to be built the same way football/basketball were.

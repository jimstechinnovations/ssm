Let me read the remaining files first to get the full picture.Now I have a complete picture. Let me think through what you're proposing clearly before responding.

Your idea is elegant: **SPM already picks 50 legs across 50 matches. The first 8 games (sorted by kickoff time) form a natural 8-game pool. Instead of one slip, use SSM v3.2/v3.3's coverage optimizer to generate 32–56 slip variants covering the binary outcome space of just those 8 games — then each variant rides the same 50-leg SPM structure but with a different resolution for the leading 8 games.**

Let me map this out precisely:Now I have everything I need. Let me lay out the architecture clearly, then diagram it.

The idea you're describing is a clean hybrid: **SPM selects 50 legs sorted by kickoff time. The first 8 games in that sorted list form an 8-game pool. Instead of picking one outcome per game for those 8, you use SSM v3.2's coverage optimizer to generate N slip variants that cover the high-probability binary outcome space of those 8 games. Each variant is a full 50-leg slip — the 8 "covered" legs differ across variants, the remaining 42 legs are identical across all.**

So rather than covering all 256 binary combinations, you pick a `costTarget` (e.g. 0.70–1.0) and let the optimizer cover the most-probable subset of those 2⁸ vectors. That gives you 32–57 variants. Each is a separate slip placed at the min stake (₦100), riding the 1000% boost.

Let me diagram this architecture:Here's the architecture precisely as you described. Let me walk through the key mechanics and the one constraint that matters most:

**What you're proposing — cleanly stated**

SPM already has 50 legs sorted by kickoff. The first 8 become the SSM pool. The optimizer enumerates their 2⁸ = 256 binary outcome vectors, ranks them by true probability (highest first), and adds vectors until the cumulative Dutch cost hits `costTarget`. The result is N covered vectors — each one becomes a full 50-leg slip by prepending its specific 8-game outcome combination to the fixed 42-leg suffix. You place all N slips at ₦100 each.

**The numbers (from v3.2's measured table, adapted)**

At 6% margin per leg, covering the 8-game pool to `costTarget 0.70` gives roughly 43 variants covering ~47% of sessions. Every covered session returns identically (Dutch staking). With 50 total legs and 1000% boost, even at ₦100 per slip your total spend is ₦4,300 on 43 slips — well within a sensible bankroll allocation.

**The one structural constraint to check**

The `one match per slip` rule from SPM v1 §5 says no two legs from the same fixture in a single slip. This is already satisfied by construction — your 8-game prefix uses one binary market per game (e.g. Over/Under 2.5), and the 42-leg suffix already has one leg per match. The legs don't overlap across games, so the rule holds automatically across all N variants.

**What you gain over a single SPM slip**

Instead of one slip covering one specific 8-game outcome pattern, you're covering the ~43 most probable patterns. The probability of any one of those patterns hitting is dramatically higher than any single pattern. This is the SSM ticket-book idea from v1 §5 — but smarter, because it's probability-ranked rather than random deviation: you're buying the *most likely* sessions first, not arbitrary single-flips.

**The remaining open question**

The `costTarget` dial controls the tradeoff. At 0.70, you get 43 slips, +43% net on any win, 47% win rate across sessions. At 1.00 you get ~79 slips, ~0% net on win, 68% win rate. The right setting depends on bankroll — at ₦100/slip, 79 slips = ₦7,900, which may exceed what you want to allocate to a single session's SPM engine. The v3.3 sweet spot recommendation of N=5 games (not 8) would reduce this significantly — something worth considering if slip count gets unwieldy.

Want me to spec out the implementation — specifically the `buildHybridBook` function that takes SPM's sorted leg list and outputs the N slip variants with Dutch stakes?
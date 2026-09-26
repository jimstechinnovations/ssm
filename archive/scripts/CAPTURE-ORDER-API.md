# Capturing SportyBet's `/orders/order` request (one-time, ~2 min)

We verified the placement endpoint is **`POST /api/ng/orders/order`** with headers
`Content-Type: application/json` + `OperId` (+ `CountryCode` for international). The request **body**
is built from SportyBet's internal betslip store and does not fire under browser automation (their
Place-Bet handler no-ops for non-human clicks — confirmed across 6 click methods and a direct store
dispatch). So we capture it once from a real placement, then the bot replays it via API.

**This capture places a real bet** — it IS your ₦100 slip going on. Nothing is wasted.

## Steps (Chrome/Edge on your machine)

1. Log in to `https://www.sportybet.com/ng/`.
2. Open DevTools: **F12** → **Network** tab. In the filter box type **`order`**. Tick **Preserve log**.
3. Load the slip: paste booking code **`KU428S`** into the betslip's *Booking Code* box → **Load**.
   (Or build any slip you want — the capture works for any.)
4. Set your stake (₦100) and click **Place Bet** for real.
5. In the Network tab, click the request named **`order`** (POST to `.../api/ng/orders/order`).
6. Right-click it → **Copy** → **Copy as cURL (bash)**. Paste that to me in the chat.
   - Alternatively: on the **Payload** tab, copy the whole JSON request body, and from **Headers**
     copy the `OperId` value.

That single cURL contains the exact body shape + headers. I turn it into
`lib/placement/place-sportybet.ts`'s API path: same request, with each slip's `selections`
swapped in and the stake set — then re-confirmed against your balance + bet history (the truth check
that already caught the earlier false positive).

## What I do with it

- Parse the captured body → a template.
- For each PEDLA slip: rebuild `ticket.selections` from the slip's legs (we already map
  `fixtureId → sr:match:<id>`, `Under/Over 4.5 → outcomeId 13/12`), set the stake, keep the rest.
- POST with your session cookies + `OperId`, then verify balance dropped / bet in history.

No payload guessing, no UI clicking, no false positives.

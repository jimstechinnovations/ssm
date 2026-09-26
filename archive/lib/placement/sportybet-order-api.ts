// lib/placement/sportybet-order-api.ts
// SportyBet order-API placement (the real fix for the UI submit being blocked under automation).
//
// Verified from the site's own JS (core.*.js → placeBet):
//   POST /api/ng/orders/order
//   headers: Content-Type: application/json;charset=UTF-8, OperId: <window.operId> [, CountryCode]
//   body: an order object M with M.ticket = { selections, bets } + stake/pay fields, built from
//         the betslip store. The body does NOT fire under automation (their handler no-ops for
//         non-human clicks), so we capture ONE real request and use it as a template.
//
// STATUS — DEAD END (captured a real request 2026-07-13): the `/orders/order` body is ENCRYPTED
// client-side (opaque base64 blob via /api/ng/patron/cipher + in-page crypto), NOT JSON. So we
// cannot build order bodies for new slips server-side, and replaying the captured blob only
// re-places that one slip. Retained for reference; real placement uses the booking-code + human-tap
// workflow (bot builds the slip and a SportyBet booking code, you place with one tap, bot settles).

import 'server-only'
import type { PedlasSlip } from '../pedlas/types'

/** The template captured from one real placement (scripts/CAPTURE-ORDER-API.md). */
export interface SportybetOrderTemplate {
  operId: string
  cookie: string                 // session cookies from the captured request
  countryCode?: string
  bodyTemplate: Record<string, unknown>  // the captured M, minus selections/stake we overwrite
}

/** Map a PEDLA leg to a SportyBet ticket selection (same mapping the booking-code API uses). */
export function legToSelection(leg: PedlasSlip['legs'][number]) {
  return {
    eventId: `sr:match:${leg.fixtureId}`,
    marketId: '18',
    specifier: `total=${leg.line}`,
    outcomeId: leg.side === 'Under' ? '13' : '12',
    odds: String(leg.odds),
  }
}

/**
 * Build the order body for a slip from the captured template. Fills in the fields that vary per
 * slip (selections + stake); everything else is copied from the real captured request.
 */
export function buildOrderBody(template: SportybetOrderTemplate, slip: PedlasSlip): Record<string, unknown> {
  const selections = slip.legs.map(legToSelection)
  const body = structuredClone(template.bodyTemplate)
  // The captured M has M.ticket.selections; overwrite it and the stake fields.
  const ticket = (body.ticket ??= {}) as Record<string, unknown>
  ticket.selections = selections
  // Common SportyBet stake fields (present in captured M) — set all that exist.
  for (const k of ['totalStake', 'stake', 'payAmount', 'actualPayAmount']) {
    if (k in body) (body as Record<string, unknown>)[k] = slip.stake
  }
  return body
}

/**
 * Place a slip via the order API. Requires a captured template. Returns the raw bizCode/response
 * so the caller can confirm against balance + history (never trust the response text alone).
 */
export async function placeViaOrderApi(
  template: SportybetOrderTemplate | null,
  slip: PedlasSlip,
): Promise<{ bizCode: number; raw: unknown }> {
  if (!template) {
    throw new Error(
      'SportyBet order-API template not configured. Capture one real /orders/order request ' +
      '(scripts/CAPTURE-ORDER-API.md) and supply it, then API placement is enabled.',
    )
  }
  const res = await fetch('https://www.sportybet.com/api/ng/orders/order', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      OperId: template.operId,
      Cookie: template.cookie,
      ...(template.countryCode ? { CountryCode: template.countryCode } : {}),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    },
    body: JSON.stringify(buildOrderBody(template, slip)),
  })
  const raw = await res.json().catch(() => ({}))
  const bizCode = (raw as { bizCode?: number }).bizCode ?? -1
  return { bizCode, raw }
}

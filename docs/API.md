# BayPook public API (`/api/v1`)

JSON over HTTPS. CORS allow-list from `ALLOWED_ORIGINS` (plus `http://localhost:3000` and `:3100`). Lightly rate-limited per IP.
All money is integer pence. All instants are ISO 8601 UTC strings. Dates are `YYYY-MM-DD` in the venue's timezone (Europe/London).

## Errors

Every error is `{ "error": { "code": string, "message": string, "limit"?: number } }` with an HTTP status:

| code | status | meaning |
|---|---|---|
| `INVALID` | 400 | Body or query failed validation. `message` says what. |
| `NOT_FOUND` | 404 | Venue, service, hold or booking not found. |
| `LIMIT` | 409 | More places than allowed. `limit` carries the number: the venue's per-booking limit, an add-on/option limit, or (on a hold) the places still left in that session, e.g. "Only 2 places left". |
| `GONE` | 409 | The time is no longer available (full, blocked, room busy, or past the cut-off). |
| `HOLD_EXPIRED` | 410 | The hold lapsed before checkout. Start again from the time step. |
| `UNAVAILABLE` | 503 | This venue cannot be booked online right now (no payment provider configured, or venue closed). |
| `RATE_LIMITED` | 429 | Too many requests. |

## Endpoints

### `GET /api/v1/venues`
```json
{ "venues": [ { "slug": "south-woodford", "name": "South Woodford", "status": "open", "opensAt": null,
  "address": "53A George Lane…", "postcode": "E18 1LN", "mapsUrl": "…", "parkingNotes": "…", "transportNotes": null,
  "maxPlacesPerBooking": 10, "onlineBookable": true, "timezone": "Europe/London" } ] }
```
`onlineBookable` is false when the venue is closed or (live mode) has no Stripe key.

### `GET /api/v1/venues/:slug/services`
Non-archived, `onlineEnabled` services in the admin's sort order.
```json
{ "services": [ { "id": "uuid", "slug": "classic-workshops", "kind": "session", "name": "Classic Workshops", "blurb": "…",
  "lengthMinutes": 60, "colour": "#5bbf3a", "leadTimeMinutes": 0, "cutoffMinutes": 60, "payInStoreEnabled": false,
  "inStoreNote": null,
  "options": [ { "id": "uuid", "name": "Slime Workshop", "blurb": "…", "unitPricePence": 1700, "includedChildren": null, "maxPerBooking": null, "inStoreNote": null },
               { "id": "uuid", "name": "Decoden Craft Workshop", "unitPricePence": 1000, "inStoreNote": { "line": "Plus your piece, £3 to £20, bought in store.", "short": "…", "menuUrl": "https://slimedom.com/workshops#decoden-menu" } } ],
  "addOns": [] },
  { "id": "uuid", "slug": "slime-party", "kind": "slot", "name": "Slime Party", "lengthMinutes": 90, "slotIntervalMinutes": 30,
  "options": [ { "id": "uuid", "name": "Slime Party package", "unitPricePence": 20000, "includedChildren": 10, "maxPerBooking": 1 } ],
  "addOns": [ { "id": "uuid", "name": "Extra child", "pricePence": 1600, "kind": "quantity", "extraMinutes": 0, "maxQuantity": 10, "perChild": true },
              { "id": "uuid", "name": "Food time", "pricePence": 5000, "kind": "time", "extraMinutes": 30, "maxQuantity": 1, "perChild": false } ] } ] }
```

### `GET /api/v1/venues/:slug/availability?service=<id|slug>&from=YYYY-MM-DD&to=YYYY-MM-DD[&extraMinutes=30]`
Window at most 62 days. `extraMinutes` (slots only) is the total extra time from time add-ons being considered, so a party with Food time is checked at 120 minutes.

Sessions: every scheduled future session in the window, with a `bookable` flag so the UI can show "3 left" and "Full".
```json
{ "kind": "session", "days": [ { "date": "2026-10-20", "sessions": [
  { "id": "uuid", "startsAt": "2026-10-20T09:00:00.000Z", "endsAt": "2026-10-20T10:00:00.000Z", "capacity": 10, "remaining": 7, "bookable": true, "reason": null } ] } ] }
```
`reason` when not bookable: `full | cutoff | lead_time | blocked | room_busy | past | cancelled`.

Slots: only bookable starts.
```json
{ "kind": "slot", "days": [ { "date": "2026-10-24", "starts": [ { "startsAt": "…", "endsAt": "…" } ] } ] }
```

### `POST /api/v1/quote`
Body: `{ "venue": slug, "service": id, "lines": [{ "optionId", "qty" }], "addOns": [{ "addOnId", "qty" }] }`
Returns `{ "quote": Quote }` (see below). Errors `INVALID`, `LIMIT`.

### `POST /api/v1/holds`
Body: `{ "venue": slug, "service": id, "sessionId"?: uuid (sessions), "startsAt"?: ISO (slots), "lines": [...], "addOns": [...] }`
Re-runs the availability check inside one transaction and holds the places/slot for the organisation's hold length (default 15 min).
```json
{ "hold": { "id": "uuid", "expiresAt": "…", "startsAt": "…", "endsAt": "…" }, "quote": Quote }
```
Errors: `GONE`, `LIMIT`, `INVALID`, `NOT_FOUND`, `UNAVAILABLE`.

### `POST /api/v1/checkout`
Body:
```json
{ "holdId": "uuid",
  "customer": { "firstName": "Amina", "lastName": "Khan", "email": "a@example.com", "phone": "07700 900123" },
  "birthdayChild": { "firstName": "Zara", "age": 7 },        // parties only
  "message": "One child has a nut allergy",                   // optional
  "accept": { "terms": true, "waiver": true },                // both required
  "returnUrl": "https://slimedom.com/book/thanks",            // optional; must be on an allowed origin; default WEBSITE_URL or BAYPOOK_URL + /book/thanks
  "payInStore": false }                                       // only honoured when the service allows it
```
Creates the pending booking from the server-side quote and a Checkout Session.
```json
{ "bookingId": "uuid", "reference": "BP-7K3M2", "checkoutUrl": "https://checkout.stripe.com/…" }
```
Pay-in-store (when allowed): `{ "bookingId", "reference", "token", "confirmed": true, "thanksUrl": "<returnUrl>?paid=0&venue=<slug>&booking=<token>" }`.
Stripe sends the customer back to `<returnUrl>?paid=1&venue=<slug>&booking=<token>` on success and `<returnUrl>?cancelled=1&venue=<slug>` on cancel. The booking is only confirmed by the webhook; the thank-you page must poll the summary until `status` is `confirmed` (or show "we're confirming your payment").
Errors: `HOLD_EXPIRED`, `INVALID`, `UNAVAILABLE`, `NOT_FOUND`.

### `GET /api/v1/bookings/:token/summary`
```json
{ "reference": "BP-7K3M2", "status": "confirmed", "paymentStatus": "paid",
  "venue": { "slug", "name", "address", "postcode", "mapsUrl", "parkingNotes" },
  "service": { "name": "Classic Workshops", "kind": "session" },
  "startsAt": "…", "endsAt": "…",
  "lines": [ { "name": "Slime Workshop", "qty": 2, "unitPence": 1700, "totalPence": 3400 } ],
  "addOns": [], "totalPence": 3400, "paidPence": 3400,
  "customer": { "firstName": "Amina" }, "inStoreNote": null, "paymentMethod": "online_card" }
```
Token is the booking's secret token (not the reference). 404 for unknown tokens.

## Quote
```json
{ "lines": [ { "optionId", "name", "qty", "unitPence", "totalPence", "includedChildren" } ],
  "addOns": [ { "addOnId", "name", "qty", "unitPence", "totalPence", "kind", "extraMinutes", "perChild" } ],
  "subtotalPence": 0, "totalPence": 0, "places": 2, "extraMinutes": 0,
  "inStoreNotes": [ "Decoden pieces are bought in store on the day, £3 to £20 each." ] }
```
`places` = session places, or total children for a slot (included + extra). Add-on rules: `maxQuantity` per add-on; per-child add-ons count towards the package's child total (included + extra must not exceed `includedChildren + maxQuantity`); time add-ons extend the booking by `extraMinutes`.

## Demo mode
`POST /api/v1/checkout` returns a `checkoutUrl` on BayPook itself (`/demo/checkout/<bookingId>`) with Pay and Decline buttons. Pay runs the same confirmation code as the Stripe webhook.

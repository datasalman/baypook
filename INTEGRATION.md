# Switching the Slimedom website's `/book` from Wix to BayPook

For whoever maintains the Slimedom website (the static Next.js export). BayPook replaces Wix as the **data source** behind `/book`; the website keeps its design and its booking steps. Each venue switches on its own, by one setting, and can be switched back the same way.

The API is described in full in [`docs/API.md`](docs/API.md). BayPook's own reference booking page (`/book` on the BayPook app, source in `src/app/book/`) uses exactly the calls below and is the working example to copy from.

## 1. A `bookingApi` setting per venue (`content/site.ts`)

Add one optional field beside `wixClientId` on the venue type:

```ts
// content/site.ts
export type Venue = {
  slug: "south-woodford" | "lakeside";
  // …existing fields…
  wixClientId?: string;
  /** BayPook API origin. When set, /book uses BayPook for this venue instead of Wix. */
  bookingApi?: string;
};

export const venues: Venue[] = [
  {
    slug: "south-woodford",
    // …
    wixClientId: "…",                          // keep until the switch is final
    bookingApi: "https://book-api.slimedom.com", // add when ready (see section 9)
  },
  // Lakeside: same, set independently
];
```

- `bookingApi` set: BayPook flow.
- Only `wixClientId` set: the Wix flow, unchanged.
- Neither: keep showing the WhatsApp request card, as today.

The venue `slug` must match BayPook's venue slug (`south-woodford`, `lakeside`; listed by `GET /api/v1/venues`).

## 2. Copy the client into the website

Copy two files verbatim. They have no dependencies and no framework imports:

| BayPook file | Website file |
|---|---|
| `src/client/client.ts` | `lib/baypook-client.ts` |
| `src/client/types.ts` | `lib/baypook-types.ts` |

Then change the one import line at the top of `lib/baypook-client.ts` from `"./types"` to `"./baypook-types"` (both the `import type { … } from` and the `export type * from` lines). Re-copy both files whenever BayPook's `docs/API.md` changes.

```ts
// lib/baypook.ts
import { createBayPookClient } from "./baypook-client";
export function baypookFor(venue: { bookingApi?: string }) {
  return venue.bookingApi ? createBayPookClient({ baseUrl: venue.bookingApi }) : null;
}
```

## 3. `BookFlow` chooses the flow

```tsx
// components/…/BookFlow.tsx
const api = baypookFor(venue);
if (api) return <BayPookBookFlow venue={venue} api={api} />;  // new: same steps, BayPook data
if (venue.wixClientId) return <WixBookFlow venue={venue} />;  // existing code, untouched
return <WhatsAppRequestCard venue={venue} />;                // existing card
```

Keep the existing step components; only the functions that fetch data and create bookings change. Section 4 lists each one.

## 4. Which Wix call becomes which BayPook call (`lib/wix-booking.ts`)

| Step | Wix today (`lib/wix-booking.ts`) | BayPook (`api` from `createBayPookClient`) |
|---|---|---|
| What can be booked | list services / price options for the project | `api.services(venue.slug)`: services in the admin's order, each with `options` (price per child, or the party package with `includedChildren`) and `addOns` (Extra child, Food time). Prices are in pence: `formatPence(1700)` gives "£17". |
| Which days and times | class sessions + appointment time slots | `api.availability(venue.slug, { service: service.id, from, to })`, `from`/`to` as `YYYY-MM-DD`, at most 62 days. Sessions come back with `remaining` and `bookable` ("3 left", "Full"); slots come back as bookable `starts` only. For a party with Food time pass `extraMinutes: 30` so only times where 120 minutes fit are offered. |
| Running total | (Wix cart totals) | `api.quote({ venue, service, lines, addOns })`. Show its `lines`, `addOns`, `totalPence` and `inStoreNotes`. Never compute prices in the browser. |
| Create the booking and go to payment | create booking, then redirect to Wix checkout | Two calls. **1.** When the customer leaves the places/extras step: `api.createHold({ venue, service, sessionId })` for a workshop or `{ …, startsAt }` for a party, plus `lines` and `addOns`. This holds the places for 15 minutes; show a countdown from `hold.expiresAt` ("We're holding your places for 14:59"). **2.** On Pay: `api.checkout({ holdId, customer, birthdayChild, message, accept: { terms: true, waiver: true }, returnUrl: \`${location.origin}/book/thanks\` })`, then `location.assign(res.checkoutUrl)` (Stripe Checkout). |
| Hold ran out | (no such thing in Wix) | `checkout` fails with code `HOLD_EXPIRED` (also when the countdown reaches zero on screen). Show the friendly message and send the customer back to the time step. |
| After payment | read the Wix booking from the redirect | Stripe returns to `/book/thanks?paid=1&venue=<slug>&booking=<token>`. `api.bookingSummary(token)` returns the booking (section 5). |

```ts
// Leaving the places step (workshop)
const { hold, quote } = await api.createHold({
  venue: venue.slug,
  service: service.id,
  sessionId: chosenSession.id,
  lines: [{ optionId: slime.id, qty: 2 }, { optionId: decoden.id, qty: 1 }],
  addOns: [],
});

// Pay button
try {
  const res = await api.checkout({
    holdId: hold.id,
    customer: { firstName, lastName, email, phone },
    birthdayChild: isParty ? { firstName: childName, age: childAge } : undefined,
    message: allergies || undefined,
    accept: { terms: termsTicked, waiver: waiverTicked },
    returnUrl: `${window.location.origin}/book/thanks`,
  });
  window.location.assign(isPayInStoreCheckout(res) ? res.thanksUrl : res.checkoutUrl);
} catch (err) {
  setError(friendlyMessage(err));
  if (err instanceof BayPookError && err.code === "HOLD_EXPIRED") goToStep("time");
}
```

Notes:
- If the customer goes back and changes the time or the places, create a new hold. The old one lapses on its own (or release it at once with `fetch(\`${venue.bookingApi}/api/v1/holds/${hold.id}\`, { method: "DELETE" })`).
- Terms and waiver: BayPook refuses the checkout unless both boxes are ticked, and stores the versions it showed.
- Pay in store (only if the owner turns it on for a service): pass `payInStore: true`; the response has `thanksUrl` instead of `checkoutUrl`.

## 5. `/book/thanks`

Read three query values: `paid`, `venue`, `booking` (the booking's secret token, not the reference). Do not rely on localStorage: everything the page needs comes from the API.

```ts
const q = new URLSearchParams(location.search);
if (q.get("cancelled") === "1") {
  // "Your payment was cancelled and nothing was taken. Your places were released." + Start again link
} else if (q.get("booking")) {
  // Poll every 2 s, for up to 60 s, until the webhook has confirmed it.
  for (let i = 0; i < 30; i++) {
    const summary = await api.bookingSummary(q.get("booking")!);
    if (summary.status === "confirmed") return show(summary);
    if (summary.status === "cancelled") return showNoLongerActive(summary);
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Still pending: "We're still confirming your payment. Your confirmation email will follow; quote <reference> if you call us."
}
```

- The booking is confirmed by Stripe's webhook, never by the redirect, so for a few seconds the summary can still say `pending`: show "Confirming your payment…" meanwhile.
- Show: `reference`, `service.name`, the date and time (format `startsAt`/`endsAt` in `timezone`), `venue.address`, `venue.mapsUrl`, `venue.parkingNotes`, the `lines` and `addOns`, `totalPence`, `inStoreNote`, and "We've emailed you a confirmation with a calendar invite. Need to change it? Message or call us."
- `paid=0` (pay in store): show the summary with "To pay in store: £X" (`totalPence − paidPence`).
- `cancelled=1&venue=<slug>`: the customer pressed back on Stripe. Nothing was charged; the places come free when the hold or the Stripe session runs out (within 15 minutes).

## 6. Error codes and what to say

Every API error has a stable `code`. `friendlyMessage(err)` in the client already maps them to customer wording; use it rather than writing your own:

| Code | When | Customer sees |
|---|---|---|
| `GONE` | Time taken, full, blocked or past the cut-off | "That time has just gone. Please pick another." |
| `LIMIT` | Too many places (`err.limit` carries the number) | "You can book up to {limit} places in one go." |
| `HOLD_EXPIRED` | The 15 minutes ran out | "Your 15 minutes ran out, so we released the places. Please choose your time again." |
| `UNAVAILABLE` | Venue closed or cannot take payments | "Online booking is not available for this venue right now. Message or call us." |
| `INVALID` | Something in the form is wrong | "Something in your booking needs another look. Please check and try again." |
| `NOT_FOUND` | Venue, service, hold or booking gone | "We could not find that. It may have changed, so please start again." |
| `RATE_LIMITED` | Too many requests | "Lots of people are booking at once. Please wait a moment and try again." |
| `NETWORK` | No response at all | "We could not reach the booking system. Check your connection and try again." |

For `GONE` on the hold, refresh availability and keep the customer on the time step.

## 7. CORS: which sites may call the API

BayPook only answers browsers from origins in its `ALLOWED_ORIGINS` environment variable (comma-separated). In the BayPook Vercel project set:

```
ALLOWED_ORIGINS=https://slimedom.com,https://www.slimedom.com,https://<the website's preview domain>
WEBSITE_URL=https://slimedom.com
```

`http://localhost:3000` and `http://localhost:3100` are always allowed for development. Any other origin is refused, and a `returnUrl` on an origin that is not listed is replaced by `WEBSITE_URL + /book/thanks`. After changing the variable, redeploy BayPook.

## 8. Deep links keep working

`/book?venue=south-woodford&type=slot&item=slime-party` (and `&date=2026-10-24`) still pre-select: `venue` is the venue slug, `type` is `session` (workshops) or `slot` (parties), `item` is the **service slug** from `api.services()` (`classic-workshops`, `slime-party`, `decoden-craft-party`). If the website's current `item` values are Wix names, map them to these slugs in one small table in `BookFlow`. Links in emails, Instagram and the FAQ do not change.

## 9. Running both side by side, and the switch

Each venue switches on its own; Wix stays live for any venue without `bookingApi`.

1. Rehearse on a preview deploy of the website with `bookingApi` pointing at BayPook in Stripe **test mode** (see `SETUP.md`). Book, pay with `4242 4242 4242 4242`, refund from the admin.
2. **Import that venue's future Wix bookings first**, so BayPook knows which places and party times are already taken. Export them from the Wix dashboard as CSV, shape them like `docs/wix-import-sample.csv`, check, then import:
   ```
   npm run import:wix -- wix-south-woodford.csv --dry-run
   npm run import:wix -- wix-south-woodford.csv
   ```
   Each row becomes a confirmed booking marked "Imported" with its Wix reference in the notes. No emails go to customers. Running it again skips rows already imported, so import again just before the switch to catch late bookings.
3. Set `bookingApi` for that venue and deploy the website. From then on, new bookings for it go to BayPook.
4. Leave the venue's Wix services open for a day for anyone mid-booking, then close online booking in that Wix project and run the import one last time.
5. To switch back, remove `bookingApi` and deploy.

What to tell customers: nothing changes for existing bookings ("your booking stands; message or call us to change it", as before). New confirmations come from BayPook's email address with a calendar invite. Staff should look in the BayPook admin, not Wix, from the switch onwards.

## 10. Keeping `book-drive.mjs` and `thanks-shot.mjs` working

Both scripts drive the website's own URLs (`/book?…` and `/book/thanks?paid=1&venue=…&booking=…`), which do not change. What changes is the data behind them:

- Point the website at BayPook's demo for CI: set the venue's `bookingApi` to `http://localhost:3100` in a test build, and start BayPook with `npm run demo` (port 3100, its own seeded data, a fake payment page with **Pay** and **Decline**, no keys needed). Add the website's dev origin to BayPook's `ALLOWED_ORIGINS` if it is not `localhost:3000`.
- `book-drive.mjs`: after the details step it now lands on BayPook's demo checkout (`/demo/checkout/<id>`) instead of Wix; click the button whose text starts with "Pay" and wait for `/book/thanks`.
- `thanks-shot.mjs`: needs a real token in `booking=`. Take it from the URL `book-drive.mjs` ends on, or book once through the demo and copy it; the page polls until the booking is confirmed, so wait for the "You're booked in" heading (or your own confirmed state) before the screenshot.
- `npm run demo:reset` wipes the demo data for a fresh run. BayPook's own Playwright smoke test (`tests/e2e/smoke.spec.ts`) drives the same flow and is a working reference.

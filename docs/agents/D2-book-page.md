Read `docs/agents/COMMON.md` in the repo `C:\Users\salma\Documents\Projects\baypook` first and follow it. You are **Agent D2: the reference booking page at `/book`**.

## Files you own
- `src/app/book/**` (page, client components, `thanks/page.tsx`), `src/app/book/_lib/*`
- `src/client/client.ts` (the typed fetch client the website will copy; your page MUST use it, nothing else, to talk to the API) and `src/client/types.ts`
- Tests: `tests/unit/client/client.test.ts` (pure: URL building, error mapping with a mocked `fetch`)
- Save a copy of this brief as `docs/agents/D2-book-page.md`.

The API itself is being built in parallel by another agent against `docs/API.md`. Code strictly against that contract. Do not create API routes. Until the real routes exist you can test the UI with `npm run demo` only partially (venues/services routes may 404); write the client so a failure shows a friendly message, and finish your UI with a small in-memory fixture mode toggled by `?fixture=1` that feeds the client sample responses matching the contract (keep it in `src/app/book/_lib/fixture.ts`, dev-only, clearly labelled). When the real API lands the director will run the flow end to end.

## `src/client/client.ts`
Dependency-free, framework-free TypeScript the Slimedom website can copy verbatim (`fetch` only, no Next imports, no `@/` imports: it must compile standalone; put shared types in `src/client/types.ts` and import them with a relative path).
```ts
export type ApiErrorCode = "INVALID" | "NOT_FOUND" | "LIMIT" | "GONE" | "HOLD_EXPIRED" | "UNAVAILABLE" | "RATE_LIMITED" | "NETWORK" | "UNKNOWN";
export class BayPookError extends Error { code: ApiErrorCode; status: number; limit?: number }
export function createBayPookClient(opts: { baseUrl: string; fetch?: typeof fetch }): {
  venues(): Promise<Venue[]>;
  services(venueSlug: string): Promise<Service[]>;
  availability(venueSlug: string, q: { service: string; from: string; to: string; extraMinutes?: number }): Promise<Availability>;
  quote(body: QuoteRequest): Promise<Quote>;
  createHold(body: HoldRequest): Promise<HoldResponse>;
  checkout(body: CheckoutRequest): Promise<CheckoutResponse>;
  bookingSummary(token: string): Promise<BookingSummary>;
}
export function friendlyMessage(err: unknown): string;  // maps codes to customer wording: GONE "That time has just gone. Please pick another.", LIMIT "You can book up to {limit} places in one go.", HOLD_EXPIRED "Your 15 minutes ran out, so we released the places. Please choose your time again.", UNAVAILABLE "Online booking is not available for this venue right now. Message or call us.", NETWORK "We could not reach the booking system. Check your connection and try again.", etc.
```
Types mirror `docs/API.md` exactly (`startsAt` strings, pence integers). Also export `formatPence(pence: number): string` ("£17", "£10.50").

## The page (`/book`)
Plain, functional, phone-first, accessible (labels, focus, contrast, reduced motion), not the website's design. Tailwind. One idea per screen, a progress indicator, Back buttons, state in the URL where it helps deep links: `/book?venue=south-woodford&type=slot&item=slime-party&date=2026-10-24` pre-selects (`type` is `session|slot`, `item` is the service slug).

Steps:
1. **Venue**: cards from `venues()`; an "opening" venue shows "Opens <date>" and is still selectable (dates before opening simply have no availability); a venue with `onlineBookable: false` shows "Message or call us to book" with the WhatsApp link from… there is no contact in the venue payload, so show a plain line "Online booking is not available here yet."
2. **What are you booking**: the venue's services in order, with blurb, length, and for sessions "From £<lowest option>"; for slots "£<package> for <included> children".
3. **Day**: a simple month grid (client-side), fetching availability in 31-day windows; days with nothing bookable are disabled. Default to the first bookable day. For slots with a time add-on, re-fetch availability with `extraMinutes` when the user toggles Food time later (so step order for slots: day → time → options; but the time add-on changes the fit. Simplest: ask for add-ons BEFORE time for slots: day → "How many children and extras" → time, re-fetching availability with `extraMinutes`. For sessions: day → time → places.)
4. **Time**: sessions as buttons "14:00 · 3 left" / "Full" (disabled) / "Too late to book online" for cutoff; slots as buttons of start times.
5. **Places / options / add-ons**: sessions: a stepper per option ("Slime Workshop £17", "Decoden Craft Workshop £10" with its in-store note line beneath); total updates from `quote()` (debounced) and the LIMIT error shows inline. Slots: package shown, "Extra children" stepper (0..max, "£16 each, up to 20 children in total"), Food time checkbox (+30 min, £50). In-store notes under the total.
6. On Continue, call `createHold`. Show a visible countdown "We're holding your places for 15:00" from `hold.expiresAt`. If the hold expires while on the form, show the HOLD_EXPIRED message with a button back to the time step.
7. **Details**: first name, last name, email, phone (all required; UK phone light validation), for slots the birthday child's first name and age (1–16), an optional message ("Allergies or anything we should know"). Two compulsory checkboxes with the exact wording: "I agree to the terms and conditions and privacy policy" (link to `https://slimedom.com/terms` — read it from a constant at the top of the file with a comment that the website owns the links) and "I have read and agree to the liability waiver". A summary panel with the line items, add-ons, in-store notes and total. **Pay £X** button (or **Book, pay in store** when the service allows pay-in-store and the user picked that option; show a radio "Pay now by card / Pay in store" only when `payInStoreEnabled`). On submit call `checkout` with `returnUrl: window.location.origin + "/book/thanks"`, then `window.location.assign(checkoutUrl)` (or go to `thanksUrl` for pay-in-store).
8. **Thanks** (`/book/thanks?paid=1&venue=…&booking=<token>`): poll `bookingSummary(token)` every 2 s for up to 60 s until `status === "confirmed"` (show "Confirming your payment…" meanwhile); then show the summary: reference, what, when, where (address + maps link + parking), what was booked, total, "We've emailed you a confirmation with a calendar invite", and "Need to change it? Message or call us". `?cancelled=1` shows "Your payment was cancelled and nothing was taken. Your places were released." with a Start again link. `?paid=0` (pay in store) shows the summary with "To pay in store: £X".
Never store card details; never trust client totals (the server quotes). Keep copy British, warm, short. "Grown-ups" not "adults". No children's names for workshops.

Also show, below the venue list on step 1, a small line "Walk-ins are welcome for workshops. Parties must be booked."

Finish with `npm run check` green for your parts and a screenshot-free verification note of each step in fixture mode.

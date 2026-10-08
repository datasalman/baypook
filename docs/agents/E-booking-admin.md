Read `docs/agents/COMMON.md` in the repo `C:\Users\salma\Documents\Projects\baypook` first and follow it. You are **Agent E: admin Bookings list, Booking detail with actions, New manual booking, Customers**.

Read before writing: `src/server/bookings.ts` (the service you call for every action; do not reimplement its logic), `src/server/customers.ts`, `src/server/availability.ts`, `src/server/catalogue.ts`, `src/server/quote.ts`, `src/server/auth.ts` (`canRefund`, `canAccessVenue`), `src/server/venue-scope.ts`, `src/components/ui/*`, `src/app/(admin)/admin/layout.tsx`, `src/app/(admin)/admin/page.tsx` (Today links to your pages), `src/app/(admin)/admin/sessions/[id]/page.tsx` (Agent C's read view: you may add action buttons there that link into your pages, but keep its structure).

## Files you own
- `src/app/(admin)/admin/bookings/**` (list, `[id]` detail + `actions.ts`, `new/**`), `src/app/(admin)/admin/customers/**`
- `src/app/(admin)/admin/sessions/[id]/page.tsx` (you may edit this one to add actions: "Add a booking to this session" → new booking preselected; "Move all" is out of scope)
- Tests: `tests/unit/server/booking-actions.test.ts` only if you add server logic of your own (prefer calling `src/server/bookings.ts`, which is already tested)
- Save a copy of this brief as `docs/agents/E-booking-admin.md`.

## Bookings list (`/admin/bookings`)
Filters: date range (default today → +14 days), status (all / confirmed / pending / cancelled / no-show), search (reference, name, email, phone), venue scope from context. Rows: date/time, service, customer name, places, status badge, paid/owed badge, reference. Link to detail. "New booking" button. Pagination by 50 with next/previous.

## Booking detail (`/admin/bookings/[id]`)
Header: reference, status badge, service, venue/room, date and time, places. Sections: **Parent** (name, phone as `tel:` link, email as `mailto:` link, customer link), **What was booked** (lines, add-ons, in-store notes, birthday child for parties, customer message), **Money** (total, paid, refunded, outstanding, payment method, payments and refunds ledger with dates), **Notes** (internal, editable textarea + Save), **History** (notifications sent with status + Resend confirmation button; calendar log; audit entries for this booking).
Actions (big buttons; confirmations only for money or deletion; each is a server action calling the booking service, then `revalidatePath` and redirect with `?flash=`):
- **Cancel** → a small form: reason (text), and if the booking has online payment and the user `canRefund`: radio "No refund" / "Full refund £X" / "Part refund £__". Confirm with `ConfirmButton`. Staff without refund permission see only "Cancel without refund" and a line "Ask a manager for refunds".
- **Give a refund** (confirmed, paid online, canRefund): amount (default full remaining), reason. Confirm.
- **Move**: choose a new date (DateNav or date input) → shows the available sessions (`getSessionAvailability` with `excludeBookingId`, ignoreTiming true) or slot starts (`getSlotStarts` with the booking's extra minutes, excludeBookingId); pick one → `moveBooking`. Explain that the parent gets a fresh confirmation email.
- **Change places / extras**: steppers like the booking page (options and add-ons from the service), live total via `quoteForService`; on save `changeBookingCounts`; if delta > 0 show "To collect in store: £X" afterwards, if delta < 0 suggest "Give a refund of £X".
- **Mark paid in store** (when owed): cash / card machine, amount prefilled.
- **Mark no-show** (confirmed, after start time; undo available).
- **Resend confirmation**.
- **Add note** (inline).

## New manual booking (`/admin/bookings/new?venue=&date=&sessionId=&service=`)
A short wizard for walk-ins and phone bookings: venue (from scope) → service → date → time (sessions with "Places taken 3 of 10", or slot starts; `ignoreTiming` true so staff can book inside the cut-off; show a hint when a time is inside the online cut-off) → places/options/add-ons with total → customer (search existing by phone/email with a small typeahead using `searchCustomers`, or type new: first, last, email, phone; email optional for walk-ins: if missing, store `walkin+<timestamp>@noemail.local` and set a flag in notes? No: make email required but offer a "No email" checkbox that stores `no-email@<venue slug>.local` and skips the email; document this in your final message) → birthday child for parties → payment: "Paid in cash" / "Paid by card machine" / "To pay in store (owed)" → notes → **Create booking**. Calls `createManualBooking` with `sendEmail` = has real email. Redirect to the detail with a flash.

## Customers (`/admin/customers`)
Search box (name, phone, email); results list; detail `/admin/customers/[id]`: contact details, editable notes, booking history (date, service, venue, status, total) with links, a "New booking for this customer" button that preselects them.

Verify in the browser with `npm run demo` as the owner: create a manual walk-in booking into tomorrow's 14:00 workshop (2 places, cash), open it, add a note, mark no-show and undo, change counts to 3, cancel it without refund; check the audit log page lists each step. Sign in as Lakeside staff and confirm `/admin/bookings/<south woodford id>` is refused (403 page or redirect with a flash). Stop the server afterwards. Finish with `npm run check` green for your parts.

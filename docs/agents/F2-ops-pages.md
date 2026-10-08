Read `docs/agents/COMMON.md` in the repo `C:\Users\salma\Documents\Projects\baypook` first and follow it. You are **Agent F2: admin Reports, Connections, Outbox, Calendar log, Jobs, Users and invites, Audit log**.

Wave 1 exists; read before writing: `src/server/auth.ts` (`requireUser`, `isOwner`, `requestMagicLink`, `CurrentUser`), `src/server/venue-scope.ts` (`getAdminContext`), `src/server/audit.ts` (`audit`, `listAudit`), `src/components/ui/*` (use the kit), `src/app/(admin)/admin/layout.tsx`, `src/server/notifications.ts` (`listOutbox`, `sendBookingEmail`), `src/server/calendar.ts` (`listCalendarLog`, `syncBookingToCalendar`), `src/providers/index.ts` (`connectionStatuses`), `src/server/jobs.ts` (`runJob`, `expireHoldsJob`, `listJobRuns`; written by Agent D1, may still be in progress: code against those names and if the file does not exist yet create `src/server/jobs-list.ts` with your own `listJobRuns` and leave a note).

## Files you own
- `src/server/reports.ts`, `src/server/users-admin.ts`
- `src/app/(admin)/admin/{reports,connections,outbox,calendar-log,jobs,users,audit}/**`
- Tests: `tests/unit/server/reports.test.ts`, `tests/unit/server/users-admin.test.ts`
- Save a copy of this brief as `docs/agents/F2-ops-pages.md`.

Scope every list by the user's visible venues (`getAdminContext().venues`); owners can pick "All".

## Reports (`/admin/reports`)
Date range picker (default: this week; presets today / this week / this month / last month) and venue scope.
- **Takings by day**: table rows per day per venue: online card (sum of succeeded payments with method online_card by `payments.createdAt` local day), in store (cash + card machine), refunds (sum of succeeded refunds), net. Totals row. 
- **Upcoming bookings** (next 14 days): count and value per venue, per service.
- **No-shows** in range: list with links.
- **Refunds** in range: list (date, booking, amount, reason, by whom).
- **Outstanding** (owed): bookings with paymentStatus owed, amount to collect.
- **CSV export**: a route handler `GET /admin/reports/export?from=&to=&venue=&kind=takings|bookings|customers` returning `text/csv` (UTF-8 BOM, RFC 4180 quoting), guarded by `requireUser` and venue scope. `bookings` export: reference, venue, service, start, end, status, customer name, email, phone, places, lines summary, total, paid, refunded, payment method, source, created. `customers` export: name, email, phone, bookings count, last booking. (Spec: export of all bookings and customers at any time, no lock-in.)
`src/server/reports.ts` exports pure-ish functions `takingsByDay(db, { venueIds, from, to, tz })`, `upcomingSummary`, `noShows`, `refundsInRange`, `outstanding`, `bookingsCsv`, `customersCsv`, `toCsv(rows: string[][])`.

## Connections (`/admin/connections`, owner only)
Rows from `connectionStatuses(venues)` with coloured state badges (connected green, demo blue, fallback amber, missing red), the detail line and the `setupStep` text linking to `SETUP.md` on GitHub (`https://github.com/datasalman/baypook/blob/main/SETUP.md`). Show the exact env var names to set. Never show values. A line at the top saying which mode BayPook is in (demo / live) and `BAYPOOK_URL`.

## Outbox (`/admin/outbox`)
Newest first, search by address/subject/reference, filter by template and status; each row expands (details/summary) to the HTML preview (iframe `srcDoc`) and text, attachments with a download link (route handler `/admin/outbox/[id]/attachment/[index]` streaming the stored content with the right content type), status, provider id, error. A "Resend" button for failed/demo rows (calls the provider again via a new `sendBookingEmail` when `bookingId` is set; else re-send raw). In demo mode an explanatory strip: "These emails were not sent. In live mode this page still lists everything sent through Resend."

## Calendar log (`/admin/calendar-log`)
Newest first; venue, booking reference (link), action, status, event id, error. A "Retry" button for failed rows (`syncBookingToCalendar` again with the same action).

## Jobs (`/admin/jobs`)
Three cards: Hold expiry, Reminders, Retention: last run time, status, summary, and a **Run now** button (server action calling the job function with `triggeredBy: "admin"`; the reminders and retention jobs may not exist yet: import them from `src/server/jobs.ts` if exported, otherwise show the button disabled with "coming soon"). Below, the last 50 `job_runs` rows.

## Users and invites (`/admin/users`, owner only)
List users with role summary (Owner / Manager at X / Staff at Y), active flag, last login. **Invite**: email, name, role (owner | manager | staff), venue (required for manager/staff) → `inviteUser(db, { by, email, name, isOwner, venues: [{ venueId, role }] })` creates the user (active) + user_venues and calls `requestMagicLink` so they get a sign-in email (in demo mode show the link). Edit roles/venues; deactivate/reactivate (never delete; audit). A user cannot deactivate themselves or remove the last owner.

## Audit log (`/admin/audit`, owner and managers)
Newest first, search (actor, action, entity id), filter by entity type; each row shows when, who, action, entity, and a details toggle with before/after JSON pretty-printed.

## Tests
`reports.test.ts`: with a seeded test db, insert customers, bookings, payments (online + cash) and one refund across two days and two venues; assert `takingsByDay` sums and `toCsv` quoting (commas, quotes, newlines). `users-admin.test.ts`: invite creates the user and venue roles and returns a link in demo mode; cannot remove the last owner.

Verify in the browser with `npm run demo` as the owner: open each page; run "Hold expiry" from Jobs and see a run row. Stop the server afterwards. Finish with `npm run check` green for your parts.

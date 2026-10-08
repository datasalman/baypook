# BayPook build state

Session started 2026-10-08 03:11 (Europe/London). Director: Claude Fable 5.1. Spec: `BAYPOOK-BUILD-PROMPT.md` and `BAYPOOK-REQUIREMENTS.md` (copies in `docs/spec/`).

## Current task

All build agents done; `npm run check` green (308 tests), Playwright smoke 2/2. Director walkthrough in demo mode passed: book 2 children → Pay → thanks; Outbox has the confirmation with .ics; Today shows "Amina K." in the 14:00 session; party over that session → GONE; party over empty 10:00 → OK and 10:00/11:00 sessions show 0 left (room_busy); 11 places → LIMIT 10; 11 extra children → LIMIT 20; Lakeside empty before 17 Oct; CORS; staff scoping; price £17→£18 in Catalogue changes the API quote. `next build` passes and `next start` in demo mode serves /api/v1, /book and /login. Demo sample bookings seeded on first boot (`BAYPOOK_DEMO_SAMPLE=0` disables). Now: two read-only review agents (security, correctness); then fixes, final docs and report.

Previously: Committed: A core/holds, B email/ics/notifications/calendar, C admin shell/auth/Today/Week/PWA, D2 `/book` + client, F1 catalogue/settings admin, F2 reports/connections/outbox/calendar-log/jobs/users/audit. Running: D1 API + checkout + webhooks + bookings service + demo checkout (files on disk, uncommitted: `src/server/bookings|checkout|webhooks|jobs|customers.ts`, `src/lib/api.ts`, `src/lib/validation.ts`, `src/app/api/**`, `src/app/demo/**`, `tests/api/**`), G reminders/retention jobs + import-wix + INTEGRATION.md + Playwright. Queued: E booking list/detail/actions + manual booking + customers admin (after D1).

## Half-finished

D1 and G running (see above). After D1: launch E, run the full demo walkthrough myself, `npm run check`, commit.

## Next three steps

1. Integrate wave 1; `npm run check`; commit.
2. Wave 2: D1 public API + checkout + webhook + bookings service + demo checkout; D2 `/book` reference page; F1 catalogue/settings admin; F2 reports/connections/outbox/jobs/users/audit admin.
3. Wave 3: E booking actions + manual booking + customers; G crons, import-wix, client.ts, INTEGRATION.md, Playwright.

## Notes for a resumed session

- Push works only with the GitHub noreply author email (`git config user.email` is set per-repo to `163465896+datasalman@users.noreply.github.com`). A stale local branch `main-old-private-email` holds the first attempt; it is safe to delete.
- `npm run demo` boots PGlite under `.data/demo`; `npm run demo:reset` wipes it.

## Stage checklist

### Stage 0: foundation (target: hour 1)
- [done] Repo, Next.js 15, Tailwind v4, TypeScript strict
- [done] Drizzle schema + first migration
- [done] PGlite demo boot (`BAYPOOK_MODE=demo`), Postgres live boot
- [done] Seed: Slimedom org, South Woodford, Lakeside, services, options, add-ons, timetable, demo owner
- [done] Provider interfaces (payment, email, calendar) + demo adapters
- [done] `npm run check` (tsc + eslint + vitest)
- [done] Minimal admin: venues + tomorrow's sessions
- [done] First push

### Stage 1: booking end to end (target: hour 3)
- [done] `src/core`: time, overlap, timetable materialisation, availability (sessions + slot starts), pricing, holds, state machine, tests (100% line coverage)
- [done] Public API: venues, services, availability, holds, checkout, booking summary; error codes; CORS; rate limit
- [done] Stripe webhook per venue; processed events; charge.refunded, dispute, session.expired
- [done] Demo fake checkout page (Pay / Decline)
- [done] Confirmation email with `.ics` (service + templates; wired to checkout by D1)
- [done] Reference booking page `/book`
- [done] Hold expiry cron + admin "Run now"

### Stage 2: admin (target: hour 6)
- [done] Auth: magic link, roles, venue scoping, demo "Sign in as owner"
- [done] Today, Week calendar, venue switcher
- [done] Booking detail + actions (cancel ± refund, move, change counts, resend, mark paid in store, no-show, note)
- [done] New manual booking
- [done] Customers
- [done] Catalogue (services, options, add-ons, timetable rules, exceptions, blocks)
- [done] Reports + CSV
- [done] Settings (org, venues, policies, terms/waiver versions, email templates, retention)
- [done] Connections, Outbox, Calendar log, Jobs, Users & invites, Audit log
- [done] PWA manifest + icons

### Stage 3: mirror, jobs, integration (target: hour 7)
- [done] Google Calendar adapter
- [done] Reminders cron, retention cron
- [done] `scripts/import-wix.ts`
- [done] `src/client/client.ts`, `INTEGRATION.md`
- [done] Playwright smoke test

### Stage 4: hand-over (final hour)
- [todo] README, SETUP, DECISIONS, `.env.example`, seed refresh, STATE complete, final report

## Report

(written at the end)

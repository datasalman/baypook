# BayPook build state

Session started 2026-10-08 03:11 (Europe/London). Director: Claude Fable 5.1, with Opus subagents. Spec: `docs/spec/BAYPOOK-BUILD-PROMPT.md` and `docs/spec/BAYPOOK-REQUIREMENTS.md`.

## Current task

Hardening pass after the MVP (all four stages done, reviewed and verified at commit 707aa31 and again after the UI-review fixes: 351 tests, Playwright 2/2). In flight: agent L (database-backed rate limit for holds/checkout/quote, active-hold cap per client, idle session timeout, retention of auth rows; schema migration `0002_rate_limits` already committed), agent R2 (second-round correctness review of the review fixes, read-only), agent P (more Playwright specs: party with Food time, conflict rule, manual booking + audit, staff scoping, price change, hold release; README screenshots under `docs/screenshots/`). After them: fix any R2 findings, `npm run check`, Playwright, `next build` in an isolated copy, final commit, fill the hash below.

If resuming mid-way: `git status` shows which of those files are uncommitted; `npm run check` tells you whether they are consistent.

Baseline statement: complete. All four stages done, reviewed and verified. See the Report below for what works, what is stubbed, test results and next steps. If you are resuming to continue work: read the Report's "What is missing" and "Three things to do next", run `npm run check`, then pick from there.

## Half-finished

Nothing.

## Next three steps (for a future session)

1. Rehearse against Stripe test mode (real test keys, `BAYPOOK_MODE=live`, a Neon database) following `SETUP.md` steps 1, 4 and 5; confirm the webhook confirms a booking and a refund syncs back.
2. Add a Vercel WAF rate-limit rule for `/api/v1/holds` and `/api/v1/checkout` (hold hoarding is the one open security item).
3. Replace the placeholder legal name, address, company number, opening hours, terms and waiver in Settings; then switch the website's `bookingApi` per venue (`INTEGRATION.md`).

## Notes for a resumed session

- Push works only with the GitHub noreply author email (`git config user.email` is set per-repo to `163465896+datasalman@users.noreply.github.com`). A stale local branch `main-old-private-email` holds the first attempt; it is safe to delete.
- `npm run demo` boots PGlite under `.data/demo` and seeds Slimedom plus sample bookings (`BAYPOOK_DEMO_SAMPLE=0` to skip them); `npm run demo:reset` wipes it. Run only one `next dev` per checkout: several share `.next` and produce random 404s.
- Subagent briefs and their deviation notes are in `docs/agents/`; the public API contract is `docs/API.md`; choices are in `DECISIONS.md`.

## Stage checklist

### Stage 0: foundation
- [done] Repo, Next.js 15, Tailwind v4, TypeScript strict
- [done] Drizzle schema + migrations (`0000_init`, `0001_review_fixes`)
- [done] PGlite demo boot (`BAYPOOK_MODE=demo`), Postgres live boot
- [done] Seed: Slimedom org, South Woodford, Lakeside, services, options, add-ons, timetable, demo users (demo mode only), email templates, sample bookings (demo only)
- [done] Provider interfaces (payment, email, calendar) + demo, Stripe, Resend and Google adapters
- [done] `npm run check` (tsc + eslint + vitest)
- [done] First push

### Stage 1: booking end to end
- [done] `src/core`: time, overlap, timetable materialisation, availability (sessions + slot starts), pricing, holds, state machine, tests (100% lines, 96.8% branches)
- [done] Public API: venues, services, availability, quote, holds (create + release), checkout, booking summary; stable error codes; CORS; rate limit
- [done] Stripe webhook per venue; processed events keyed by venue; checkout.session.completed, payment_intent.succeeded, checkout.session.expired, charge.refunded, charge.dispute.created; amount and currency check
- [done] Demo fake checkout page (Pay / Decline / Abandon)
- [done] Confirmation email with `.ics` (sequence increases on move/cancel)
- [done] Reference booking page `/book` (deep links, hold countdown, hold release, thanks page polling)
- [done] Hold expiry job + admin "Run now" + `/api/cron/expire-holds`

### Stage 2: admin
- [done] Auth: magic link (HMAC token, single use, 15 min), roles owner/manager/staff, venue scoping, demo sign-in buttons
- [done] Today, Week calendar, venue switcher, session page
- [done] Booking list, detail and actions (cancel ± refund, move, change counts keeping sold prices, resend, mark paid in store, no-show/undo with capacity check, notes)
- [done] New manual booking wizard (walk-in / phone; cash, card machine, pay-in-store owed; existing-customer typeahead)
- [done] Customers (search, history, notes)
- [done] Catalogue (services, options, add-ons, timetable rules, exceptions, blocks, single sessions)
- [done] Reports (takings by day online/in store, refunds, upcoming, no-shows, outstanding) + CSV exports
- [done] Settings (organisation, venues + rooms, policies, terms/waiver versions, email templates with preview, retention)
- [done] Connections, Outbox (with `.ics` download and resend), Calendar log (retry), Jobs (run now), Users and invites, Audit log
- [done] PWA manifest + icons; phone layout checked at 375px

### Stage 3: mirror, jobs, integration
- [done] Google Calendar adapter (service account, REST) + calendar service and log
- [done] Reminders cron (24 h, once, idempotent), retention cron (anonymise after 24 months)
- [done] `scripts/import-wix.ts` (CSV, dry run, duplicate detection by external ref)
- [done] `src/client/client.ts` + `types.ts`, `INTEGRATION.md`
- [done] Playwright smoke (book + pay; owner refund)

### Stage 4: hand-over
- [done] README (demo walkthrough), SETUP, INTEGRATION, DECISIONS (32 entries), `.env.example`, `vercel.json`
- [done] Security review (no critical/high; mediums fixed; one documented gap) and correctness review (16 findings fixed with 24 regression tests)
- [done] Production build (`next build`) and `next start` in demo mode verified
- [done] Final report below

## Report

### 1. What works, by stage, with the demo steps

Run `npm run demo`, open http://localhost:3100/login, press **Sign in as owner**.

**Stage 0.** Today lists both venues; South Woodford shows hourly workshop sessions with sample bookings; Lakeside shows "opens on Saturday 17 October" and nothing before that date. Change the date with the arrows.

**Stage 1.** Open http://localhost:3100/book. South Woodford, Classic Workshops, Saturday 24 October, 14:00, two Slime Workshop places, your details, both boxes, **Pay £34**. On the demo checkout press **Pay**. The thanks page says "You're booked in" with the reference. In the admin: Outbox shows the confirmation with `booking-<ref>.ics`; Bookings shows it Confirmed and Paid; Today shows the parent under 14:00. On `/book`, a Slime Party is not offered at times that overlap that session; at 10:00 it is offered, and after holding it the 10:00 and 11:00 workshop sessions show as full (`room_busy` in the API). Eleven places gives "Up to 10 places per booking." Abandon a checkout, wait for the hold length (Settings, minimum 5 minutes), then Jobs, Hold expiry, **Run now**: the pending booking is cancelled and the places return. A party with Food time (11:00 to 13:00, 14 children, £314) confirms with an owner "New party" email, a confirmation and a calendar log row.

**Stage 2.** Booking detail: give a part refund, move to another time, change places (sold prices kept), mark paid in store, no-show and undo, resend, notes; every step is in the Audit log. New booking: a cash walk-in with no email goes straight in as confirmed. Catalogue: change the Slime Workshop price to £18 and `POST /api/v1/quote` returns 1800 per place immediately. Sign out, **Sign in as Lakeside staff**: only Lakeside is visible, a South Woodford booking URL is refused, Settings/Users/Connections say owner only, no refund button. Connections lists every provider as Demo with the exact env var names.

**Stage 3.** A party booking writes a Calendar log row (and a Google event in live mode) and an owner "New party" email. Jobs, Reminders and Retention run from the Jobs page. `npm run import:wix -- docs/wix-import-sample.csv --dry-run` shows what would be imported. `src/client/client.ts` is the file the website copies; `INTEGRATION.md` lists the exact website changes.

**Stage 4.** `README.md`, `SETUP.md`, `INTEGRATION.md`, `DECISIONS.md`, `.env.example`, `vercel.json`, this file.

Hold-expiry verification on a fresh database after the review fixes (8 Oct, hold length set to 5 minutes in Settings): hold created 04:44:21Z expiring 04:49:21Z, pending booking BP-RTHWF, session remaining 10 → 7 while pending; `/api/cron/expire-holds` after expiry returned `expired 1, checkoutsExpired 1, bookingsCancelled 1`; remaining back to 10.

### 2. What is missing or stubbed, and why

- **Stripe, Resend and Google have real adapters but were not exercised against real accounts** (no keys in this session). The Stripe adapter follows the Checkout Sessions, Webhooks and Refunds APIs; the first rehearsal must be Stripe test mode (SETUP step 1.6).
- **Hold hoarding** (security review): `POST /api/v1/holds` is unauthenticated and the in-process rate limit is per serverless instance. Mitigation is a Vercel WAF rule (SETUP step 5.6); a shared limiter (Upstash or Postgres counters) is the code fix.
- **P2 items left as interfaces only:** SMS/WhatsApp (the `notifications.channel` column and `EmailProvider` shape), Stripe Terminal (`PaymentProvider`), waiting list, ICS feed, register view, Stripe Connect.
- **Google Calendar is one-way**; events are never read back.
- **Idle session timeout** is not enforced (30-day sessions; `lastSeenAt` is recorded). Account enumeration by response timing on the login form is possible in theory.
- **Form validation errors redirect with a flash** and lose typed values on some admin forms (HTML validation catches most first).
- **Known lock-order difference** between webhook confirmation (booking → hold) and checkout/expiry (hold → booking); Postgres aborts one side and Stripe retries.
- **Reminders use `reminderSentAt` as the idempotency guard** rather than the notification table, so a reminder resent manually from the Outbox is not deduplicated.

### 3. Env vars and accounts the owner must create, in order (SETUP.md)

1. Stripe: two accounts under one login → `STRIPE_SECRET_KEY__SOUTH_WOODFORD`, `STRIPE_WEBHOOK_SECRET__SOUTH_WOODFORD`, `STRIPE_SECRET_KEY__LAKESIDE`, `STRIPE_WEBHOOK_SECRET__LAKESIDE` (test keys first; webhook endpoints `/api/webhooks/stripe/<slug>` with the five events).
2. Resend: domain DNS (SPF, DKIM, DMARC) → `RESEND_API_KEY`, `EMAIL_FROM`, optional `OWNER_ALERT_EMAIL`.
3. Google Cloud: Calendar API + service account JSON → `GOOGLE_SERVICE_ACCOUNT_JSON` (or `_BASE64`); share each venue calendar with the service account; paste calendar IDs in Settings, Venues.
4. Neon (or Supabase) → `DATABASE_URL`; `npm run db:migrate`.
5. Vercel: `BAYPOOK_MODE=live`, `APP_SECRET`, `BAYPOOK_URL`, `WEBSITE_URL`, `ALLOWED_ORIGINS`, `CRON_SECRET`; domains `book-api.slimedom.com` and `admin.slimedom.com`; build command `npm run db:migrate && npm run build`; WAF rate-limit rule.
6. First owner: `npx tsx scripts/seed.ts --owner you@slimedom.com`, then sign in by magic link; replace placeholders in Settings; invite staff.

### 4. Test results

- `npm run check`: typecheck clean, lint clean, Vitest 27 files / 337 tests passing (about 90 s; the PGlite tests dominate).
- `npm run test:coverage`: `src/core` 99.4% statements, 96.8% branches, 100% functions, 100% lines (thresholds 90/80/90/90).
- `npm run test:e2e`: Playwright 2/2 (book two children and pay; owner finds the booking and refunds). Needs port 3100 free and `.data/e2e` wiped; about 55 s.
- `next build`: passes; `next start` in demo mode serves `/api/v1`, `/book`, `/login`.
- Flaky only when several `next dev` servers run from one checkout (shared `.next`); run one at a time.

### 5. Git

Every task was committed and pushed to `https://github.com/datasalman/baypook` on `main`. Pushes succeeded after switching the author to the GitHub noreply email (the first attempt was refused by GitHub's email-privacy setting). Latest commit hash: HASH_PLACEHOLDER.

### 6. Three things to do next

1. Stripe test-mode rehearsal end to end (checkout, webhook confirmation, refund sync, dispute) on a staging Vercel project with a Neon database.
2. Shared rate limiting for holds and checkout (Vercel WAF now; Upstash/Postgres counters in code), and a captcha or email confirmation for pay-in-store checkouts if that toggle is ever turned on.
3. Owner polish from a real rehearsal: keep typed values on admin form errors, an idle session timeout, and the P2 register view for tick-in on the day.

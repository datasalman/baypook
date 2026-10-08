# Build BayPook (MVP) in one long unattended session

You are building **BayPook**, a booking and payments system for Slimedom (two slime-workshop and party venues in London and Essex), to replace Wix behind the Slimedom website's `/book` page. It is its own product in its own repo. The website is a separate project and you must not touch it; you ship a client and an integration guide for it instead.

Read `BAYPOOK-REQUIREMENTS.md` in this folder first, fully. It is the specification: sections 2 (what Wix got wrong), 3 (requirements, tagged MVP / P2 / Later), 4 (shape), 6 (decisions, all made) and 3.12 (demo mode). Build everything tagged MVP. Do not build P2 or Later items beyond leaving the interface for them.

## How this session runs

- You have 5–8 hours and nobody is watching. **Never stop to ask a question.** Where the spec is silent, choose the option that is simplest for a non-technical owner, make it editable in the admin where it is a value, and record the choice in `DECISIONS.md`. Where an external thing is missing (a key, an account, DNS), build the adapter fully, make demo mode cover it, and write the exact step for the owner in `SETUP.md`.
- **Checkpoint relentlessly.** Keep `STATE.md` at the repo root with: the task list below with each item marked todo / doing / done, the current task, what is half-finished, and the next three steps. Update it before and after every task. Commit and push after every task (`git add -A && git commit && git push origin main`). If the push fails (auth), keep committing locally, retry the push at each checkpoint, and say so in the final report. If this session is cut off, a fresh session must be able to resume from `STATE.md` alone.
- **Subagents.** Use `Agent` subagents with `model: "opus"` for independent, well-bounded work once the schema and provider interfaces exist (for example: the availability engine with its tests; the email templates and `.ics` builder; the admin calendar views; the reference booking page). Give each one the file paths it owns, the interfaces it must satisfy and the test command. Run independent subagents in parallel. You own the schema, the provider interfaces, `STATE.md` and the integration between pieces; never let two agents edit the same file.
- **Time budget.** Stage 0 by the end of hour 1, stage 1 by hour 3, stage 2 by hour 6, stage 3 by hour 7. Whatever the clock says at the start of the final hour, stop adding features and do stage 4 (verification, seed, docs, demo walkthrough). An honest, working, smaller BayPook beats a broad broken one.
- Commit messages: plain English, present tense, one line plus a short body when useful.
- No destructive git operations. Never force-push. Never commit secrets: `.env*` is gitignored; `.env.example` is committed with every variable named and explained.

## Repository

- Remote: `https://github.com/datasalman/baypook` (fresh). If this folder is not yet a git repo: `git init -b main`, `git remote add origin https://github.com/datasalman/baypook.git`. If the remote already has commits (a README or licence), `git pull origin main --allow-unrelated-histories` first. Push `main`.
- Check `gh auth status` once at the start. If it fails, continue locally and leave the push attempts to each checkpoint.
- Layout (single Next.js app, no monorepo):

```
baypook/
  README.md            what it is, how to run demo, how to go live (short; points to SETUP.md)
  SETUP.md             every account, key and DNS step for the owner, in order, with where to paste what
  INTEGRATION.md       exactly how the Slimedom website switches /book from Wix to BayPook
  DECISIONS.md         choices you made that the spec left open
  STATE.md             the running checkpoint (see above)
  .env.example
  src/app/             Next.js App Router
    (admin)/admin/…    the admin UI
    book/…             the reference booking page (plain, functional, not the website's design)
    api/v1/…           the public API the website calls
    api/webhooks/stripe/[venue]/route.ts
    api/cron/…         reminders, hold expiry, retention (Vercel Cron, protected by CRON_SECRET)
  src/db/              Drizzle schema, migrations, seed
  src/core/            availability, holds, bookings, pricing, conflict rules (pure, tested)
  src/providers/       payment/ email/ calendar/ each with an interface, a real adapter and a demo adapter
  src/client/          client.ts: the typed client the website will copy
  tests/               Vitest unit tests; Playwright smoke tests in demo mode
  scripts/             demo launcher, seed, Wix CSV import, Stripe webhook helper
```

## Fixed technical decisions

- **Next.js 15 (App Router), TypeScript strict, Tailwind v4.** Node 20+. `npm`.
- **Database: Postgres via `DATABASE_URL` with Drizzle ORM** and SQL migrations (`drizzle-kit`). **Demo mode uses PGlite** (embedded Postgres in Node) through the same Drizzle schema, so the schema is written once. Use only SQL that both run.
- **Money in integer pence. Times stored in UTC, every rule evaluated in `Europe/London`** (use `date-fns-tz` or Temporal polyfill; test the BST→GMT weekend in late October and the 16:00-end vs 16:00-start edge).
- **Stripe**: Checkout Sessions (hosted), one Stripe account per venue. Env: `STRIPE_SECRET_KEY__<venueSlug>` and `STRIPE_WEBHOOK_SECRET__<venueSlug>`. Webhook route per venue. Refunds via the Refunds API. Confirm bookings only from `checkout.session.completed` (and `payment_intent.succeeded` as a belt-and-braces path), never from the return URL. Store the Stripe event IDs you have processed and ignore repeats. Handle `charge.refunded`, `charge.dispute.created`, `checkout.session.expired`.
- **Email: Resend** (`RESEND_API_KEY`, `EMAIL_FROM`), with React Email or plain HTML templates and an `.ics` attachment on confirmations. Demo adapter writes to the `outbox` table, shown in the admin.
- **Calendar: Google Calendar API** with a service account (`GOOGLE_SERVICE_ACCOUNT_JSON`, and a calendar ID per venue in settings). One-way push; store the Google event ID on the booking so updates and cancellations hit the same event. Demo adapter logs to a `calendar_log` table shown in the admin.
- **Auth: magic link by email** (signed, single-use, 15-minute token; httpOnly session cookie). Roles owner / manager / staff; manager and staff are scoped to one venue. Demo mode offers a "Sign in as owner" button on the login page and prints the link into the Outbox too.
- **Public API** under `/api/v1`, JSON, CORS allow-list from `ALLOWED_ORIGINS` (default includes `http://localhost:3000`), rate-limited lightly. Errors are `{ error: { code, message } }` with stable codes the website can map: `GONE`, `LIMIT`, `HOLD_EXPIRED`, `INVALID`, `UNAVAILABLE`.
- **Scheduled work**: `/api/cron/*` routes protected by `CRON_SECRET`, with `vercel.json` cron entries (hold expiry every 5 min, reminders hourly, retention daily). Record every run in a `job_runs` table shown in the admin.
- **Secrets**: env only. An `APP_SECRET` for signing tokens and sessions. The admin **Connections** page reads env presence, never values.
- **Demo mode** is `BAYPOOK_MODE=demo`; `npm run demo` sets it, boots PGlite, migrates, seeds Slimedom, opens on port 3100. Live mode is `BAYPOOK_MODE=live` (default) and requires `DATABASE_URL` and `APP_SECRET`; everything else degrades to "not connected" on the Connections page and the provider falls back to the demo adapter with a visible warning banner in the admin (so a half-configured live system can never silently drop emails or payments: a venue with no Stripe key cannot be booked online and the API says so).

## Domain model (build this first, stage 0)

`organisations` (one row, "Slimedom": name, legal name, address, company number, contact email/phone/WhatsApp, brand colours, logo URL, terms text + version, waiver text + version, retention months, default timezone)
`venues` (slug, name, status open/opening, opensAt, address, maps URL, parking/transport notes, Google calendar ID, booking policy: max places per booking, lead-time defaults)
`rooms` (venue, name; South Woodford one room "Main room", Lakeside two: "Workshop floor", "Party room")
`services` (venue, kind `session` | `slot`, name, blurb, length minutes, room, sort order, online enabled, pay-in-store toggle, lead time minutes, cut-off minutes, in-store note line/short/menu URL, colour)
`service_options` (service, name e.g. "Slime", "Decoden", unit price pence, included count for slots, max per booking) — sessions sell places per option; a slot has one option (the package) with `includedChildren`
`add_ons` (service, name, price pence, kind `quantity` | `time`, extra minutes, max quantity, per-child flag e.g. "Extra child")
`timetable_rules` (service, weekday, start time, capacity, valid from/to) and `timetable_exceptions` (date, cancel | add | change capacity)
`sessions` (materialised occurrences: service, room, start, end, capacity, status) — generate on demand for the visible window and cache; never let the website depend on a generator job
`blocks` (venue, room nullable, start, end, reason) — closed days, private hire
`holds` (venue, service, session nullable, start, end, lines JSON, expires at, checkout id)
`customers` (venue-agnostic within the organisation: first, last, email, phone, notes, marketing never)
`bookings` (reference like `BP-7K3M2`, venue, service, room, start, end, status pending | confirmed | cancelled | no_show, customer, lines JSON {optionId, qty, unitPence}, add-ons JSON, totals, birthday child first name + age for slots, source online | manual | import, payment method, terms version, waiver version, accepted at, token for future self-service, Google event id, notes)
`payments` (booking, provider, provider ids, amount, status, method online_card | card_machine | cash, created by) and `refunds` (payment, amount, reason, status, provider id, created by)
`users`, `user_venues` (role per venue), `magic_links`, `sessions_auth`
`audit_log` (who, what, entity, before/after JSON)
`notifications` (booking, channel email, template, to, status, provider id, body snapshot) doubling as the demo Outbox
`calendar_log`, `job_runs`, `processed_webhook_events`, `settings` (key/value for anything else editable)

## Core rules (stage 0, pure functions in `src/core`, Vitest, ≥ 90% of this folder covered)

1. **Availability.** `availableSessions(venue, service, dayRange)` and `availableSlotStarts(venue, service, day)`. A session is bookable if: within lead time and cut-off, not blocked, remaining capacity > 0 after confirmed bookings and live holds, and (room rule) no confirmed or held **slot** booking overlaps it in the same room. A slot start is bookable if: within lead time and cut-off, the whole slot (length + any time add-on being considered) fits inside opening hours, no block overlaps, no confirmed or held slot booking overlaps in the same room, and no **session with at least one confirmed or held place** overlaps in the same room. An empty session does not block a slot. Lakeside's party room is separate, so no cross-blocking there. Overlap is `start < otherEnd && end > otherStart` (16:00 end does not overlap 16:00 start).
2. **Holds.** Creating a hold re-runs the availability check inside one transaction with `SELECT … FOR UPDATE` on the session/room rows (PGlite: still use the transaction; keep the same code). Hold length from settings (default 15 min). Expired holds are ignored by availability and deleted by cron.
3. **Pricing.** Quote = Σ option qty × unit + add-ons (quantity × price; per-child add-ons honour the included count and the max children); return a line-item breakdown the UI prints. Never trust client totals: the Checkout Session is built from the server quote.
4. **Capacity per booking** from the venue policy; the API returns `LIMIT` with the limit value.
5. **Booking state machine.** pending (hold + checkout created) → confirmed (webhook) | cancelled (expired or declined). confirmed → cancelled (admin, optional refund) | no_show. Manual bookings are created confirmed with a payment of method cash/card_machine or marked owed when pay-in-store.
6. **Reminders** 24h before, once, only for confirmed bookings, idempotent via the notifications table.

## Stages and acceptance

**Stage 0 (hour 1): foundation.** Repo, Next.js, Tailwind, Drizzle schema and first migration, PGlite demo boot, seed (Slimedom org; South Woodford and Lakeside with the facts below; services, options, add-ons, timetable; one demo owner user), provider interfaces with demo adapters, `npm run check` (tsc + eslint + vitest), `STATE.md`, first push. Acceptance: `npm run demo` opens an admin that lists the two venues and tomorrow's sessions from the seed.

**Stage 1 (hours 1–3): booking end to end.** `src/core` rules with tests; public API: `GET /api/v1/venues`, `GET /api/v1/venues/:slug/services`, `GET /api/v1/venues/:slug/availability?service=&from=&to=`, `POST /api/v1/holds`, `POST /api/v1/checkout` (creates the Stripe Checkout Session or, in demo, a BayPook fake checkout page), `GET /api/v1/bookings/:token/summary` (for the thank-you page); Stripe webhook per venue; demo fake checkout page with "Pay" and "Decline"; confirmation email with `.ics`; the reference booking page at `/book` (venue → service → day → time → places/options/add-ons → details → terms + waiver boxes → pay → thanks) using the same API the website will use. Acceptance: in demo mode, book two children into a session, pay, see the email in the Outbox with the `.ics`, see the booking confirmed in the admin list; a party booked over that session is refused; a party booked over an empty session succeeds and that session then shows 0 available on `/book`; abandon a payment and watch the hold expire (make the cron route callable from the admin "Run now" button).

**Stage 2 (hours 3–6): the admin.** Phone-first, installable (manifest + icons), fast. Pages: Today (per venue; owner has a venue switcher and an "All" view), Week calendar, Booking detail with actions (cancel with/without refund, move, change counts, resend email, mark paid in store, mark no-show, add note), New manual booking (walk-in / phone; cash or card machine; pay-in-store owed), Customers (search, history), Catalogue (services, options, add-ons, timetable rules, exceptions, blocks, per venue; edits take effect on the next availability call), Reports (takings by day and venue split online / in store, refunds, upcoming, no-shows, CSV export), Settings (organisation, venues, policies, terms and waiver with version bump, email templates with preview, retention), Connections (each provider: connected / missing / demo, with the `SETUP.md` step), Outbox, Calendar log, Jobs, Users and invites, Audit log. Refund permission enforced server-side. Acceptance: every action above works in demo mode and is logged in the audit log; staff for Lakeside cannot see South Woodford bookings; the owner can change a price and the `/book` quote changes.

**Stage 3 (hours 6–7): mirror, jobs, integration.** Google Calendar adapter (create/update/delete; store event id); reminders cron; retention cron (anonymise bookings older than the setting); `scripts/import-wix.ts` taking a CSV of future Wix bookings (reference, venue, service name, start, names, email, phone, places, paid total) and creating confirmed bookings with payment method `imported`; `src/client/client.ts` (typed fetch wrapper over `/api/v1` with the error codes) and `INTEGRATION.md` describing the switch in the Slimedom website: a `bookingApi` field on the venue in `content/site.ts` beside `wixClientId`, `BookFlow` choosing BayPook when it is set, which API calls replace which Wix SDK calls in `lib/wix-booking.ts`, how `/book/thanks` reads the summary by token, and the CORS origins to add. Acceptance: `npm run check` green; a Playwright smoke test runs the demo booking flow and the admin refund.

**Stage 4 (final hour): make it hand-over-able.** `README.md` (what it is, `npm run demo`, screenshots optional), `SETUP.md` (Stripe account per venue: keys, webhook endpoint URL and events, test mode first; Resend domain + DNS; Google service account and sharing the calendar; Neon/Supabase `DATABASE_URL`; Vercel project, env vars, cron, domains `admin.` and `book-api.`; first owner login), `DECISIONS.md`, `.env.example`, seed refreshed, `STATE.md` marked complete with known gaps, final commit and push. Then write the final report (below).

## Seed facts (Slimedom)

Organisation: Slimedom, "Magical Kingdom of Slime", hello@slimedom.com, +44 7498 254704, WhatsApp wa.me/447498254704, legal name / address / company number as placeholders flagged in settings. Colours: pick a friendly slime-green primary and ink text; the owner can change them.

South Woodford: slug `south-woodford`, open, 53A George Lane, South Woodford, London E18 1LN; one room. Opening hours as placeholders (seed Tue–Sun 10:00–18:00 and mark "confirm"). Policy: max 10 places per booking.
Lakeside: slug `lakeside`, status opening, opensAt 2026-10-17T10:00:00+01:00, Lakeside Shopping Centre, West Thurrock Way, Grays RM20 2ZP; rooms "Workshop floor" and "Party room"; hours as placeholders (seed 10:00–20:00). Policy: max 10 places per booking.

Services per venue (same shape, per-venue prices editable):
- "Classic Workshops" (session, 60 min, capacity 10, workshop room): options "Slime Workshop" £17, "Decoden Craft Workshop" £10 with in-store note "Plus your piece, £3 to £20, bought in store." / "Decoden pieces are bought in store on the day, £3 to £20 each." / menu URL `https://slimedom.com/workshops#decoden-menu`. Timetable: hourly from opening to one hour before closing, every open day. Cut-off 60 min. Lead time 0.
- "Slime Party" (slot, 90 min, party room at Lakeside / the one room at South Woodford): package £200 includes 10 children, add-on "Extra child" £16 quantity up to 10 (max 20 children), add-on "Food time" £50 time +30 min. Lead time 48 h. Starts every 30 min within hours.
- "Decoden Craft Party" (slot, 90 min): package £250 includes 8, "Extra child" £25 up to 12, "Food time" £50 +30 min. Lead time 48 h.

Terms and waiver text: seed short placeholders that say they are placeholders and point at slimedom.com/terms; version 1. Email templates: confirmation (summary, address, parking line, "what to wear: something you don't mind getting glittery", in-store note when relevant, "Need to change it? Message or call us", `.ics`), reminder, cancellation, refund, owner new-party alert. Copy is British, warm, short, no exclamation marks in headings, no emojis.

## Quality bar

- The admin must be usable one-handed on a phone by someone who is not technical: big targets, one idea per screen, plain words ("Places taken", "Paid in store", "Give a refund"), confirmations only for money or deletion. Reduced motion respected. Keyboard and screen-reader basics (labels, focus, contrast).
- British English throughout. "Grown-ups" not "adults". Children's personal data is not collected for workshops.
- Every list that can grow has search or a date filter. Every destructive action is reversible or audited.
- Nothing hard-codes Slimedom beyond the seed. Venue, prices, copy, colours and policies come from the database.
- Tests: `src/core` unit tests including the BST edge, overlap edges, the empty-session-gives-way rule, hold expiry, per-child add-on pricing with included counts; API tests for the error codes; one Playwright smoke in demo mode. `npm run check` must be green at every push.
- Lint clean, `tsc --noEmit` clean, no `any` outside adapters' third-party boundaries.

## When you are cut off and resumed

If a new session starts with "Continue building BayPook from STATE.md", read `STATE.md`, `DECISIONS.md` and the last five commits, run `npm run check`, fix anything red, then carry on from the current task. Do not re-plan or restart stages that are marked done.

## Final report (last thing you write, into `STATE.md` under "Report" and as your last message)

1. What works, by stage, with the demo steps to see each thing.
2. What is missing or stubbed, and why.
3. Every env var and account the owner must create, in order (pointing at `SETUP.md`).
4. Test results (`npm run check` output summary) and anything flaky.
5. Whether `git push` succeeded; the latest commit hash.
6. The three things you would do next.

Start now: read `BAYPOOK-REQUIREMENTS.md`, create `STATE.md` with the stage checklist, then stage 0.

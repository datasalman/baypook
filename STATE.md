# BayPook build state

Session started 2026-10-08 03:11 (Europe/London). Director: Claude Fable 5.1. Spec: `BAYPOOK-BUILD-PROMPT.md` and `BAYPOOK-REQUIREMENTS.md` (copies in `docs/spec/`).

## Current task

Stage 0: foundation (schema, db boot, seed, providers, check script).

## Half-finished

Nothing yet.

## Next three steps

1. Write Drizzle schema + first migration, PGlite demo boot, seed.
2. Provider interfaces with demo adapters; `npm run check`; minimal admin listing venues and tomorrow's sessions.
3. First push; then spawn subagents for core rules, email templates, admin shell.

## Stage checklist

### Stage 0: foundation (target: hour 1)
- [doing] Repo, Next.js 15, Tailwind v4, TypeScript strict
- [todo] Drizzle schema + first migration
- [todo] PGlite demo boot (`BAYPOOK_MODE=demo`), Postgres live boot
- [todo] Seed: Slimedom org, South Woodford, Lakeside, services, options, add-ons, timetable, demo owner
- [todo] Provider interfaces (payment, email, calendar) + demo adapters
- [todo] `npm run check` (tsc + eslint + vitest)
- [todo] Minimal admin: venues + tomorrow's sessions
- [todo] First push

### Stage 1: booking end to end (target: hour 3)
- [todo] `src/core`: time, overlap, timetable materialisation, availability (sessions + slot starts), pricing, holds, state machine, tests (≥90% coverage)
- [todo] Public API: venues, services, availability, holds, checkout, booking summary; error codes; CORS; rate limit
- [todo] Stripe webhook per venue; processed events; charge.refunded, dispute, session.expired
- [todo] Demo fake checkout page (Pay / Decline)
- [todo] Confirmation email with `.ics`
- [todo] Reference booking page `/book`
- [todo] Hold expiry cron + admin "Run now"

### Stage 2: admin (target: hour 6)
- [todo] Auth: magic link, roles, venue scoping, demo "Sign in as owner"
- [todo] Today, Week calendar, venue switcher
- [todo] Booking detail + actions (cancel ± refund, move, change counts, resend, mark paid in store, no-show, note)
- [todo] New manual booking
- [todo] Customers
- [todo] Catalogue (services, options, add-ons, timetable rules, exceptions, blocks)
- [todo] Reports + CSV
- [todo] Settings (org, venues, policies, terms/waiver versions, email templates, retention)
- [todo] Connections, Outbox, Calendar log, Jobs, Users & invites, Audit log
- [todo] PWA manifest + icons

### Stage 3: mirror, jobs, integration (target: hour 7)
- [todo] Google Calendar adapter
- [todo] Reminders cron, retention cron
- [todo] `scripts/import-wix.ts`
- [todo] `src/client/client.ts`, `INTEGRATION.md`
- [todo] Playwright smoke test

### Stage 4: hand-over (final hour)
- [todo] README, SETUP, DECISIONS, `.env.example`, seed refresh, STATE complete, final report

## Report

(written at the end)

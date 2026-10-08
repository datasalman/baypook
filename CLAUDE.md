# BayPook: notes for Claude Code sessions

BayPook is a booking and payments system (Next.js 15 App Router, TypeScript strict, Tailwind v4, Drizzle + Postgres/PGlite, Stripe Checkout, Resend, Google Calendar). Read `STATE.md` first when resuming, then `DECISIONS.md` and `docs/API.md`. The spec is in `docs/spec/`.

## Run and check

- `npm run demo` starts demo mode on port 3100 (embedded PGlite under `.data/demo`, seeded, sample bookings; `npm run demo:reset` wipes it). Owner sign-in button on `/login`.
- `npm run check` = typecheck + lint + Vitest. It must be green before every commit. PGlite tests take about 100 s.
- `npm run test:e2e` runs Playwright against its own demo server on port 3100 with `.data/e2e`. Free the port and `rm -rf .data/e2e` first. Screenshots: `SCREENSHOTS=1 npx playwright test tests/e2e/screenshots.spec.ts`.
- Run only one `next dev` per checkout: several share `.next` and cause random 404s. For a parallel server, copy the repo (without `node_modules`, `.next`, `.data`) and junction `node_modules`.
- Schema changes: edit `src/db/schema.ts`, then `npm run db:generate -- --name <what>`; check the SQL in `src/db/migrations/` (drizzle-kit cannot name a dropped primary key; write that line by hand). Demo migrates at boot; live migrates in the Vercel build command.

## Conventions

- Money in integer pence. Store UTC `Date`s; evaluate every rule in the organisation timezone with `src/core/time.ts` helpers (`zonedDateTime`, `localDate`, `overlaps`). Overlap is half-open.
- Pure rules live in `src/core` (100% line coverage expected); database-backed services in `src/server`; providers behind the interfaces in `src/providers/types.ts` with a demo adapter each.
- Every state change goes through `src/server/bookings.ts` and is audited (`src/server/audit.ts`). Side effects (email, calendar, Stripe expiry) run after the transaction commits, never inside it.
- Lock order: hold → booking → session → room.
- Admin pages call `getAdminContext()` themselves and scope by `ctx.selectedVenues`; the layout does not protect pages. Refunds need `canRefund`; settings, users and connections are owner-only.
- British English, warm and short; "grown-ups" not "adults"; no exclamation marks in headings; no emojis. Nothing hard-codes Slimedom outside `src/db/seed.ts`.
- Secrets come from env only; the Connections page shows presence, never values. Never commit `.env*` except `.env.example`.
- Commits: plain English, present tense, author email must be the GitHub noreply address already set in this repo's git config.

## Where things are

| area | files |
|---|---|
| availability, pricing, state machine | `src/core/*.ts` |
| holds, checkout, bookings, webhooks, jobs | `src/server/{holds,checkout,bookings,webhooks,jobs,jobs-reminders,jobs-retention}.ts` |
| public API | `src/app/api/v1/**`, `src/lib/api.ts`, `src/lib/validation.ts`, `docs/API.md` |
| admin | `src/app/(admin)/admin/**`, UI kit `src/components/ui`, auth `src/server/auth.ts` |
| booking page + client | `src/app/book/**`, `src/client/client.ts` |
| emails | `src/providers/email/*`, `src/server/notifications.ts` |
| subagent briefs and deviations | `docs/agents/*.md` |

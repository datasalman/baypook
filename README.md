# BayPook

Booking and payments for Slimedom's slime-workshop and party venues (South Woodford and Lakeside), built to replace Wix behind the website's `/book` page. One admin for both venues, phone-first; Stripe Checkout with one Stripe account per venue; email confirmations with calendar attachments; a Google Calendar mirror; and a public API the website calls.

## Try it in two minutes (demo mode)

```bash
npm install
npm run demo
```

Then open http://localhost:3100/admin, click **Sign in as owner**. Demo mode runs an embedded Postgres under `.data/demo`, seeds Slimedom's venues and catalogue, fakes payments (a Pay / Decline page), writes every email to the **Outbox** page and every calendar push to the **Calendar log**. Nothing leaves your machine. `npm run demo:reset` wipes it.

The reference booking page is at http://localhost:3100/book (plain, functional, not the website's design). It uses the same `/api/v1` the website will use.

## Going live

Read `SETUP.md`: Stripe keys and webhooks per venue, Resend DNS, a Google service account, a Neon database, Vercel env vars, cron and domains, then the first owner login. `INTEGRATION.md` explains the website switch.

## Repository map

```
src/app/(admin)/admin/   the admin UI
src/app/book/            the reference booking page
src/app/api/v1/          the public API (docs/API.md)
src/app/api/webhooks/    Stripe webhook per venue
src/app/api/cron/        hold expiry, reminders, retention (Vercel Cron, CRON_SECRET)
src/db/                  Drizzle schema, migrations, seed
src/core/                availability, pricing, state machine, timetable (pure, tested)
src/server/              database-backed services (holds, bookings, notifications, calendar, auth)
src/providers/           payment / email / calendar: interface + real adapter + demo adapter
src/client/client.ts     the typed client the website copies
tests/                   Vitest unit and API tests; Playwright smoke test in demo mode
scripts/                 demo launcher, seed, Wix CSV import
```

## Commands

| command | what |
|---|---|
| `npm run demo` | demo mode on port 3100 |
| `npm run dev` | live mode on 3000 (needs `.env.local`, see `.env.example`) |
| `npm run check` | typecheck + lint + unit tests |
| `npm run test:coverage` | unit tests with coverage of `src/core` |
| `npm run test:e2e` | Playwright smoke test (starts the demo itself) |
| `npm run db:generate` / `db:migrate` | Drizzle migrations |
| `npm run import:wix -- file.csv` | import future Wix bookings |

## Documents

- `docs/spec/` the requirements and build prompt
- `docs/API.md` the public API contract
- `DECISIONS.md` choices the spec left open
- `STATE.md` build checkpoint and final report

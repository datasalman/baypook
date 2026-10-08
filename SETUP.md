# Going live: every account, key and DNS step, in order

You can rehearse everything first with `npm run demo` (no accounts needed). Do the steps below when you are ready to take real bookings. Each step says where to paste what. The admin's **Connections** page (More, Connections) turns green as each one lands.

Allow about two hours in total, plus waiting for Stripe and DNS checks.

## 0. Before you start

- A GitHub account with access to `github.com/datasalman/baypook`.
- Your `slimedom.com` DNS login (where the domain's records are managed).
- The business bank account details for each venue (for Stripe payouts).
- A terminal with Node 20 or newer for the one-off database migration (`node --version`).

Keep a private note of every key you create. Never paste keys into the website code, emails or chats; only into Vercel's environment variables (step 5).

## 1. Stripe: one account per venue

Each venue has its own Stripe account so payouts land in separate bank accounts. Both accounts live under one Stripe login.

1. Go to https://dashboard.stripe.com and sign in (or create the login once). Create an account named **Slimedom South Woodford**. Complete the business details and add that venue's bank account.
2. In the top-left account switcher choose **New account** and create **Slimedom Lakeside** the same way.
3. **Start in test mode.** With the test-mode toggle on, open Developers, API keys, and copy the **Secret key** (`sk_test_…`) for each account.
   - South Woodford → Vercel variable `STRIPE_SECRET_KEY__SOUTH_WOODFORD`
   - Lakeside → `STRIPE_SECRET_KEY__LAKESIDE`
4. Webhooks (one per account). Developers, Webhooks, **Add endpoint**:
   - Endpoint URL: `https://book-api.slimedom.com/api/webhooks/stripe/south-woodford` (and `/lakeside` for the Lakeside account).
   - Events to send: `checkout.session.completed`, `checkout.session.expired`, `payment_intent.succeeded`, `charge.refunded`, `charge.dispute.created`.
   - After saving, reveal the **Signing secret** (`whsec_…`) → `STRIPE_WEBHOOK_SECRET__SOUTH_WOODFORD` / `STRIPE_WEBHOOK_SECRET__LAKESIDE`.
5. Apple Pay and Google Pay: Settings, Payment methods, make sure **Apple Pay** and **Google Pay** are on. Stripe Checkout shows them automatically on supported devices. Because checkout is hosted by Stripe, no domain verification is needed.
6. Rehearse with test cards (`4242 4242 4242 4242`, any future date, any CVC) on the live site. Check the booking confirms in the admin and the email arrives.
7. **Go live:** switch the toggle off (live mode), repeat steps 3 and 4 with the live keys and a live webhook endpoint, and replace the four variables in Vercel. Redeploy.

Fees: 1.5% + 20p per standard UK card. No monthly fee. Disputes cost £20 and show up in the admin.

## 2. Resend: email from @slimedom.com

1. Create an account at https://resend.com (free tier: 3,000 emails a month, 100 a day; upgrade to Pro if a busy Saturday hits the daily cap).
2. Domains, **Add domain**: `slimedom.com`, region EU (Ireland). Resend shows DNS records: one or more `TXT` (SPF and DKIM) and an `MX` for bounces.
3. Add those records at your DNS provider exactly as shown. If Google Workspace already owns the root SPF record, Resend's records use a subdomain (`send.slimedom.com`), so nothing clashes. Add a DMARC record if you do not have one: `_dmarc.slimedom.com TXT "v=DMARC1; p=quarantine; rua=mailto:hello@slimedom.com"`.
4. Click **Verify** in Resend and wait until every record is green (minutes to an hour).
5. API keys, **Create API key** (Sending access only) → `RESEND_API_KEY`.
6. Set `EMAIL_FROM` to `Slimedom <bookings@slimedom.com>` and, optionally, `OWNER_ALERT_EMAIL` to the inbox that should get new-party alerts (defaults to the organisation contact email in Settings).

## 3. Google Calendar: the mirror

1. In Google Calendar (the Workspace account), create one calendar per venue, e.g. **Slimedom South Woodford** and **Slimedom Lakeside**. Share them with every staff member who should see bookings on their phone.
2. Go to https://console.cloud.google.com, create a project **BayPook**, enable the **Google Calendar API** (APIs and services, Library).
3. IAM and admin, Service accounts, **Create service account** (name `baypook-calendar`). Open it, Keys, **Add key**, JSON. A file downloads. Keep it private.
4. Share each venue calendar with the service account's email address (it looks like `baypook-calendar@baypook-xxxx.iam.gserviceaccount.com`) with permission **Make changes to events**.
5. Open each calendar's settings and copy its **Calendar ID** (ends in `@group.calendar.google.com`). In the BayPook admin: Settings, Venues, paste it into **Google Calendar ID** for that venue.
6. Put the whole JSON key file's contents on one line into `GOOGLE_SERVICE_ACCOUNT_JSON`. If Vercel's editor mangles newlines, base64-encode the file instead and set `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`.

## 4. Database: Neon (or Supabase)

1. Create a project at https://neon.tech, region **EU (Frankfurt or London)**, Postgres 16 or newer. The Launch plan (about US$19 a month) includes backups; the free tier is fine for rehearsal but has no point-in-time restore.
2. Copy the **pooled** connection string (`postgres://…?sslmode=require`) → `DATABASE_URL`.
3. Apply the schema once from your computer (and again after any update that adds a migration):
   ```bash
   DATABASE_URL="postgres://…" npm run db:migrate
   ```
   The Vercel build command in step 5 also runs this, so a redeploy keeps the database up to date.
4. Supabase works the same way: Project settings, Database, connection string (use the **Session pooler** URL). Use the Pro plan for backups.

## 5. Vercel: hosting, env vars, cron, domains

1. Import `github.com/datasalman/baypook` at https://vercel.com/new. Framework: Next.js. Root directory: `/`.
2. Build command: `npm run db:migrate && npm run build`. Install command: `npm ci`.
3. Environment variables (Production, and Preview if you want a staging copy with a second database):
   - `BAYPOOK_MODE=live`
   - `DATABASE_URL` (step 4)
   - `APP_SECRET` (a long random string: `openssl rand -hex 32`)
   - `BAYPOOK_URL=https://book-api.slimedom.com`
   - `WEBSITE_URL=https://slimedom.com`
   - `ALLOWED_ORIGINS=https://slimedom.com,https://www.slimedom.com`
   - `CRON_SECRET` (`openssl rand -hex 24`)
   - The Stripe (step 1), Resend (step 2) and Google (step 3) variables
4. Deploy. The `vercel.json` in the repo registers the cron jobs (hold expiry every 5 minutes, reminders hourly, retention daily). Vercel signs them with `CRON_SECRET`.
5. Domains: Settings, Domains, add `book-api.slimedom.com` and `admin.slimedom.com`. Vercel shows a `CNAME` for each (`cname.vercel-dns.com`); add them at your DNS provider. Both names serve the same deployment; the API lives under `/api/v1`, the admin under `/admin`.
6. Plan: BayPook is a commercial app, so the project must sit on a **Pro** team (US$20 a seat). If the website already has a Pro seat, add this project to the same team at no extra cost.

## 6. First owner login

1. On first deploy there is no user yet. Create the owner with the seed command once:
   ```bash
   DATABASE_URL="postgres://…" BAYPOOK_MODE=live npx tsx scripts/seed.ts --owner you@slimedom.com
   ```
   This seeds Slimedom's venues and catalogue (if the database is empty) and makes that email the owner.
2. Open `https://admin.slimedom.com/login`, enter the email, click the link in the email (Resend must be live; until then the Outbox page is not reachable because you cannot log in, so do step 2 before this one).
3. Settings: replace the placeholder legal name, address and company number; confirm opening hours; paste the real terms and waiver (bumping the version); check prices.
4. Invite staff: More, Users, **Invite** (email + venue + role). They receive their own magic link.

## 7. Switching the website from Wix

Follow `INTEGRATION.md`. In short: set `bookingApi: "https://book-api.slimedom.com"` on each venue in the website's `content/site.ts` when that venue is ready; the website's `/book` flow then calls BayPook instead of Wix. Import any future Wix bookings first with `npm run import:wix -- bookings.csv`.

## Checklist

- [ ] Stripe South Woodford: test keys, webhook, then live keys
- [ ] Stripe Lakeside: test keys, webhook, then live keys
- [ ] Resend domain verified, API key, `EMAIL_FROM`
- [ ] Google service account JSON, calendars shared, IDs pasted in Settings
- [ ] Neon database, `DATABASE_URL`, migration applied
- [ ] Vercel project, env vars, domains, cron
- [ ] Owner login works; placeholders replaced in Settings
- [ ] Staff invited
- [ ] Future Wix bookings imported
- [ ] Website `bookingApi` set per venue

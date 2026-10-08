# BayPook: requirements for Slimedom's own Stripe-based booking system (8 Oct 2026)

BayPook is a booking and payments system built for Slimedom's circumstances, to replace Wix behind the website's `/book` page. It is its own project and repo (`github.com/datasalman/baypook`), not part of the website. The website keeps its design and its `/book` flow; only the data source changes.

Status: requirements and costing, with the open decisions now made (section 6). Drawn from `booking-system-findings.md` and `booking-platform-recommendation.md` (27 Sep research), `booking-conflict-south-woodford.md` and `booking-conflict-build-guide.md` (7–8 Oct), the site's `CLAUDE.md`, `TODO.md`, `LAUNCH-DAY.md`, `content/site.ts` and the `/book` code. Prices checked on 8 Oct 2026; sources at the end.

## 1. Short answer

This is buildable, and the scope is much smaller than the "custom build" the 27 Sep research priced at 40–70 developer days. That estimate carried deposits and balances, self-service rescheduling, a native app with Tap to Pay and a four-week deadline. Since then Salman has dropped deposits (paid in full), dropped self-service (changes are "contact us"), and decided prices are not shown on the site. Walk-ins are recorded by staff against the existing card machine. What is left is a classic capacity-and-slot booking system with Stripe Checkout, a mobile-friendly admin and email notifications: roughly 20–30 focused days with Claude Code, in stages, with a usable first pass in one long session.

Two conditions:

1. **Not before Lakeside opens (17 Oct).** Wix stays for launch. BayPook is built alongside, both run for a week, then `/book` switches over by changing one setting per venue (the same pattern as `wixClientId`).
2. **Single-tenant first.** Built for Slimedom only, with "venue" as a first-class object from day one and an `organisation` record above it, so other businesses could be added later. Multi-tenant sign-up, billing and onboarding are not part of the MVP.

Running cost at today's modelled volume (two venues, 330 payments and £11,850 a month each): **about £490 a month in Stripe fees plus £20–£52 a month in hosting, database and email**. For comparison the 27 Sep research put Vagaro at £557 a month and Square at £555 for two venues, both with their own gaps, and Wix costs its two premium plans plus Wix Payments' rate (check the Wix billing page for the exact figures).

## 2. The problems with Wix (what BayPook must not repeat)

Collected from the chats and findings, 2–8 October.

**Availability and double bookings**
- Wix has two availability engines. Appointments (parties) are offered wherever the staff member is free; classes (workshops) are offered purely from their own timetable and capacity. A party can never block a workshop natively; a workshop blocks parties only if its session is marked "Busy", and then it blocks whether or not anyone has booked. The probe showed party times still offered over a Friday workshop with three children booked. Fixing it needs three Wix Automations with Velo code, an account-owner API key and two undocumented behaviours (per-instance capacity caps, the moment "Session booked" fires). It is asynchronous, so two payments in the same minute can still clash, and the only hard gate needs a Wix app.
- Resources do nothing for class-vs-appointment clashes. Blocked time does not affect classes either.
- The old Bookings Sessions/Schedules APIs are deprecated; Calendar V3 has no Velo module in a headless project.

**Bookings and payments**
- Abandoned payments leave bookings in `CREATED` forever: no documented expiry, no hold on the place.
- Express checkout (the Google Pay button) ends on Wix's thank-you page, not `/book/thanks`; card payments do come back.
- Allowed redirect domains must be listed in each project, and a missing domain only shows after a real payment.
- The checkout tab reads "Checkout | Project 1"; moving checkout to a Slimedom subdomain needs a premium plan.
- A visitor cannot read or cancel a booking by its ID. The anonymous token comes only from Wix's email or from a backend with an API key (`getAnonymousActionToken` is 403). Rescheduling was refused for workshop bookings with price options and never isolated.
- The "Manage booking" button in Wix's emails opens Wix's own page; if a customer cancels there, Wix frees the place and by its documentation does not refund the card.
- Wix cannot price the Decoden piece bought in store, so the site carries that one price itself.
- Lakeside's default policy allows one participant per booking; capacity and limits live in each project and must be set twice.

**Two projects, two of everything**
- One Wix Headless project per venue so payments stay separate: two dashboards, two sets of policies, notification emails, redirect domains, frontend links, services and test data. Service names, option names and add-on names show exactly as typed in each project.
- Test bookings can only be deleted by Salman in each dashboard.
- Confirmation emails only go if the automation is on in each project; the reply-to must be set in each.

**The original must-haves from 27 Sep that Wix does not meet either**
- One admin, web and phone, across both venues, with refunds inside it (no separate payment dashboard).
- Staff logins scoped to a venue; the owner sees both.
- Walk-ins recorded in the same system as online bookings.
- Automatic email confirmations and reminders.

## 3. Requirements

Each line is tagged **MVP** (needed to replace Wix), **P2** (soon after) or **Later** (only if asked). Facts in brackets come from `content/site.ts` and the terms. Wherever a value could change (a price, a lead time, a capacity, a line of email copy), it is a setting the owner edits in the admin, never a constant in code.

### 3.1 Catalogue (what can be booked)

- MVP: Two venues, South Woodford and Lakeside, each with its own services, prices, timetable, capacity and **its own Stripe account**. Venue is a first-class object; nothing branches on a venue slug.
- MVP: Two workshop types (Slime-Making, Decoden) as **sessions**: a timetable of start times, a length, a capacity (10–12 at South Woodford, per venue), a per-child price per venue (currently £17 and £10 at South Woodford). One booking can hold several children, mixing types in one session (the Wix "price options" pattern: "Choose your workshops", one stepper per type).
- MVP: Two party types (Slime Party £200 includes 10 children, £16 per extra; Decoden Craft Party £250 includes 8, £25 per extra; max 20) as **slots**: free start times at a configurable interval (30 min), 90 minutes long, one booking per slot.
- MVP: Add-ons per service with price, quantity limits and optional extra time (Food time, £50, +30 minutes). Extra children as a quantity add-on with a per-venue price and a maximum (20 total).
- MVP: Per-venue prices and names, editable by the owner in the admin without code. The website shows no prices; `/book` reads them from the API.
- MVP: In-store notes per service (Decoden pieces £3–£20 bought on the day) shown beside the price and under the total.
- P2: Schools and groups as enquiries only (the existing Formspree form), not bookable.
- Later: gift vouchers, memberships, retail. (Plan says no shop, no vouchers.)

### 3.2 Availability and conflicts

- MVP: Each venue has one or more **rooms**. South Woodford has one room: a booked workshop session blocks any overlapping party slot, a booked party (90 or 120 minutes with Food time) blocks every workshop session it overlaps, and an **empty** workshop session gives way to a party. Lakeside has a party room, so parties and workshops do not block each other there. This is a single database rule, checked in the same transaction as the booking, so it is synchronous and cannot be raced.
- MVP: Capacity per session, with the remaining places shown ("3 left at this time") and a per-booking maximum from the venue's policy.
- MVP: A **hold** on places or a slot while the customer pays (15 minutes), released on expiry or payment failure. No booking is ever left pending forever.
- MVP: Owner can block time (closed days, private hire, a one-off cancellation), change one session's capacity, or add an extra session, all from the admin.
- MVP: A venue that is "opening" only offers dates from its opening date (`opensAt`); never hard-coded.
- MVP: Lead time and cut-off rules per service (defaults: parties need 48 hours' notice; workshops bookable until 60 minutes before the start), editable.
- P2: Waiting list for a full session.

### 3.3 Customer booking flow (`/book`)

- MVP: Venue → what are you booking (the venue's own list, in the admin's order) → day → time → children/options and add-ons → contact details → two compulsory boxes (terms and privacy; condensed liability waiver) → Pay. Same shape as today, so the website UI changes little; only the data source moves from the Wix SDK to the BayPook API.
- MVP: Deep links keep working: `/book?venue=…&type=…&item=…` pre-select.
- MVP: Contact details: first name, last name, email, phone. Ask for the birthday child's first name and age for parties; do not store children's names for workshops (keep personal data to the parent).
- MVP: Pay in full by card, Apple Pay and Google Pay, in GBP, through **Stripe Checkout** (hosted). Card data never touches BayPook's servers (PCI SAQ-A). The return URL is always `/book/thanks` on the website, with the booking summary available to that page by a one-time token.
- MVP: Walk-ins welcome: the site keeps saying so; nothing in the flow implies booking is compulsory for workshops. Parties must be booked.
- MVP: Clear, customer-friendly failures: time gone, place limit reached, offline, payment declined, with the hold released.
- MVP: No "manage my booking" link for customers. Emails and FAQs say "message or call us".
- MVP: A per-service **"pay in store" toggle** (default off) for workshops, should Salman want it later; when on, the booking confirms without payment and shows as owed in the admin.
- Later: Self-service cancel or reschedule, if the policy changes. Every booking already has a secure token so this can be added without a migration, but no page is built now.

### 3.4 Payments, refunds, payouts

- MVP: **One Stripe account per venue** so payouts land in separate bank accounts (decided 8 Oct). Both accounts under one Stripe login; BayPook holds a secret key and webhook secret per venue, and each venue has its own webhook endpoint.
- MVP: Full and partial refunds from the admin (Stripe Refunds API), with a reason, by anyone with the refund permission. Refund status synced back by webhook. The admin never needs the Stripe dashboard day to day.
- MVP: Every booking carries a payment ledger: paid, refunded, outstanding, method (online card, card machine in store, cash), so takings per day per venue reconcile with Stripe payouts and the till.
- MVP: Webhooks are idempotent and signature-verified; a paid booking is confirmed by the webhook, never by the browser alone.
- MVP: Disputes surfaced in the admin (Stripe charges £20 per dispute).
- MVP: Walk-ins are taken on the existing card machine (or cash) and recorded in the admin as a manual booking marked paid in store (decided 8 Oct).
- P2: Stripe Terminal for walk-ins taken inside the admin: a smart reader per venue (S700, £229 + VAT, server-driven from the web admin) at 1.4% + 10p. The payment-provider interface leaves room for it.
- Later: Tap to Pay on the owner's phone (needs a native app and Apple approval; not worth it at this size).
- Later: Stripe Connect, if other businesses ever use the system.

### 3.5 Admin (web app, phone-first, installable as a PWA)

- MVP: Log in by emailed magic link. Roles: owner (everything, both venues), manager (one venue, refunds), staff (one venue, no refunds). Invite by email; audit log of who did what.
- MVP: Today and week view per venue: sessions with names and places taken, party blocks, blocked time. A combined view for the owner.
- MVP: Booking detail: parent's details, what was booked, add-ons, paid and refunded, notes (allergies, anything the parent said). Actions: cancel (with or without refund), move to another session or slot (capacity and conflict checked), change counts, resend confirmation, mark paid in store, mark no-show.
- MVP: Manual booking for phone and walk-in customers, with cash or card machine as the payment method, so every child in the room is in one list.
- MVP: Catalogue management: services, prices, options, add-ons, timetable, capacity, policies, email wording, per venue, without code.
- MVP: Customers: search by name, phone or email; booking history; notes.
- MVP: Reports: takings by day and venue (online vs in store), refunds, upcoming bookings, no-shows; CSV export. Owner sees both venues, staff see their own.
- MVP: Settings: organisation details (legal name, address, company number, contact details, branding), venue details, terms and waiver text with version numbers, email templates, retention period, connection status for each provider.
- MVP: **Demo mode** so Salman can rehearse the whole thing without Stripe, email or a hosted database, and never leave test bookings in a live system (see 3.12).
- P2: Daily register view for the session (tick children in), printable.
- P2: Owner notification on every new party booking and on cancellations (email in MVP if trivial).

### 3.6 Calendar

- MVP: The admin's own calendar is the source of truth.
- MVP: Push every confirmed booking, change and cancellation to a **Google Calendar per venue** (free API, service account) so Salman and staff see bookings on their phones' calendar apps alongside everything else. One-way: Google is a mirror, never a source.
- MVP: An `.ics` attachment in the customer's confirmation email ("Add to calendar").
- P2: A private subscribe-able calendar feed per venue (ICS URL) as a zero-cost alternative for staff without Google accounts.
- Later: Two-way sync (blocking time by creating events in Google). Fragile; do it in the admin instead.

### 3.7 Notifications

- MVP (decided 8 Oct: **email only** at first): confirmation with summary, address, parking, what to wear, in-store Decoden note, "need to change it? message or call us", and the `.ics`; reminder 24 hours before; cancellation and refund confirmations; owner alerts. Sent from an `@slimedom.com` address with SPF, DKIM and DMARC (already on the launch list). Templates editable in the admin.
- P2: SMS reminder the day before (Twilio, UK alphanumeric sender "Slimedom" is free; about 4p a message). The notification interface has a channel field so this is an adapter, not a rewrite.
- P2: WhatsApp Business Platform confirmations: Salman already runs the business on WhatsApp, utility templates cost about 1.6p each (free inside a 24-hour service window), but it needs Meta business verification and a provider (Twilio or similar), so it is a phase on its own.
- Never: marketing email or newsletter sign-up (removed 3 Oct). No SMS marketing.

### 3.8 Website integration

- MVP: The website stays a static export. `/book` calls BayPook's public API (availability, catalogue, create hold, create checkout) over HTTPS with CORS limited to the website's domains. `BookFlow` switches by a per-venue setting (`bookingApi` beside `wixClientId`); the WhatsApp request card stays for a venue with neither.
- MVP: Stripe returns the customer to the website's `/book/thanks?paid=1&venue=…&booking=…`; the page reads the summary from the API by a one-time token, not from localStorage alone.
- MVP: BayPook ships a small typed client (`client.ts`) and an `INTEGRATION.md` that says exactly which files in the website change. It also ships its own plain reference booking page so the flow can be demonstrated and tested without the website.
- MVP: Hosted at `book-api.slimedom.com` (or `api.`); the admin at `admin.slimedom.com`. Subdomains are free.
- MVP: Existing website scripts (`book-drive.mjs`, `thanks-shot.mjs`) keep working against the new backend.

### 3.9 Legal, data protection, trust

- MVP: UK GDPR: Slimedom is controller; Stripe, the host, the database and the email provider are processors with published DPAs. Data kept in the EU/UK region where the provider allows. Retention rule (default: bookings kept 24 months, then anonymised; editable). Privacy policy updated to name the new processors instead of Wix.
- MVP: Only the parent's details are stored; no children's names or dates of birth for workshops. The birthday child's first name and age only for parties.
- MVP: Terms and the condensed waiver ticked at booking, with the version and timestamp stored against the booking.
- MVP: Bookings are paid in full, non-refundable for no-shows and lateness, full refund or new date if Slimedom cancels (terms, section on payment). The admin's refund tool implements the owner's discretion; the system never auto-refunds a customer cancellation.
- MVP: Strong Customer Authentication handled by Stripe. No card details stored anywhere.
- MVP: Legal name, address and company number on receipts and emails, read from settings (placeholders until Salman supplies them).

### 3.10 Operations and reliability

- MVP: Serverless hosting with automatic deploys, a staging environment, daily database backups, error tracking, uptime check. No single point that only one person can operate: the owner can rotate Stripe keys and log in to every provider.
- MVP: Everything idempotent (webhooks can arrive twice or out of order); BST and GMT handled in `Europe/London`; the 16:00 end of one booking never overlaps a 16:00 start.
- MVP: Export of all bookings and customers at any time (no lock-in), and a documented migration from Wix: future bookings re-entered or imported (CSV) before the switch.
- MVP: Accessibility and reduced motion as on the site; the admin works on a phone with one hand.
- MVP: Scheduled jobs (reminders, hold expiry, retention) with a visible last-run time in the admin.

### 3.11 Explicitly out of scope

Deposits and balances; self-service change or cancel pages; native mobile apps; Tap to Pay; marketplace listings; gift vouchers; shop; newsletter; multi-tenant sign-up and billing; automatic refunds on customer cancellation; a timeline or running order for parties; prices on the marketing pages; SMS and WhatsApp (P2).

### 3.12 Demo mode (works with no API keys)

- MVP: `npm run demo` starts BayPook with an embedded database, Slimedom's two venues and catalogue seeded, a demo owner login that needs no email, a fake payment page that "pays" or "declines" on a button, an in-app **Outbox** showing every email that would have been sent, and a log of calendar events that would have been pushed. Nothing leaves the machine.
- MVP: The same code paths run in demo and live; only the provider adapters differ (`demo` vs `stripe`, `resend`, `google`). A **Connections** page in the admin shows each provider as connected, missing or demo, with a one-line instruction for what to paste where.
- MVP: Stripe **test mode** is a separate state from demo: real Stripe test keys, real test cards, everything else real. This is the rehearsal before going live.

## 4. Shape of the MVP (so the costs make sense)

- **One repo, `baypook`**: Next.js (App Router: public API routes, the admin UI, a reference booking page) on Vercel, Postgres via `DATABASE_URL` (Neon or Supabase) with Drizzle ORM, an embedded Postgres (PGlite) for demo mode, Stripe Checkout + Webhooks + Refunds, Resend for email, Google Calendar API for the mirror, Vercel Cron for reminders, hold expiry and retention. Same stack family as the website, so Claude Code and the existing scripts carry over.
- **Data model**: organisation → venue → room → service (session or slot type) → price options and add-ons → timetable rules and exceptions → generated sessions/slots → holds → bookings → booking lines → payments and refunds → customers → users, roles, audit log → notification log → settings.
- **Availability** is one function per venue ("what can start at time T in room R given existing confirmed bookings and holds") so the website, the admin and the conflict rule all use the same answer.
- **Providers** behind interfaces: `PaymentProvider` (stripe, demo), `EmailProvider` (resend, demo), `CalendarProvider` (google, demo, none). Adding Twilio, WhatsApp or Stripe Terminal later is a new adapter.
- **Stage order**: (1) schema, catalogue, availability, holds, Stripe Checkout, webhooks, confirmation email, reference booking page, demo mode; (2) the admin (calendar views, booking actions, manual bookings, refunds, catalogue editing, settings, Connections, Outbox, reports); (3) Google Calendar mirror, reminders, retention, CSV import/export, integration client and guide; (4) later: SMS/WhatsApp, Terminal, waiting list.
- **Rough effort** with Claude Code: a first working pass of stages 1–3 in one long session, then 10–20 days of polish, testing against Stripe test mode, parallel running and the switch-over, spread over October–November, none of it before 17 October.

## 5. Day-to-day running costs (Slimedom only)

Volume model, carried over from the 27 Sep research: per venue per month 300 workshop places at £17 and 30 parties at £225, taken as 330 card payments and £11,850. Two venues: 660 payments, £23,700. A quieter early-months case is also shown: 150 payments and about £5,400 per venue.

| Item | What it is | Modelled volume (2 venues) | Quiet case (2 venues) | Notes |
|---|---|---|---|---|
| Stripe card processing | 1.5% + 20p per standard UK card; Apple Pay and Google Pay at the card's rate | **£487.50** | **£222** | Premium UK cards 2.8% + 20p, EEA 2.5% + 20p, international 3.15% + 20p. The processing fee is not returned on a refund. No monthly fee. Two accounts cost the same as one. |
| Stripe Checkout and webhooks | Included with Payments | £0 | £0 | A custom checkout domain is US$10 a month; not needed (the return page is ours anyway). |
| Stripe disputes | £20 per dispute | £0–£20 | £0–£20 | Rare at this ticket size; the £20 is refunded if won. |
| Stripe payouts | Standard payouts free | £0 | £0 | Instant payouts cost 1% (min 40p); don't use them. |
| Hosting (Vercel) | Pro, US$20 per developer seat; the Hobby plan does not allow commercial use | **£0–£16** | £0–£16 | £0 extra if the website is already on a Pro seat (BayPook is one more project on the same seat). Check which plan the website is on. |
| Database (Neon or Supabase Pro) | Managed Postgres with backups | **£15–£20** | £15–£20 | Supabase Free pauses after a week of inactivity and has no backups: not acceptable for bookings. Neon's paid plan from about US$19; Supabase Pro US$25. |
| Email (Resend) | 3,000 emails a month free with a 100-a-day cap; Pro US$20 for 50,000 | **£0–£16** | £0 | ~2,000 emails a month at modelled volume fits the free tier, but a busy Saturday (60 bookings × 3 emails) can hit the 100-a-day cap; Pro removes it. |
| Google Calendar API | Free | £0 | £0 | Google Workspace for `@slimedom.com` is already on the launch list for email; its calendars are the mirror. |
| Scheduled jobs, error tracking, uptime | Vercel Cron (included), Sentry and Better Stack free tiers | £0 | £0 | |
| Domain and subdomains | `book-api.` and `admin.slimedom.com` | £0 | £0 | Already own the domain. |
| **Infrastructure total** | | **£15–£52** | **£15–£36** | |
| **Infrastructure + Stripe** | | **about £505–£540** | **about £240–£260** | |

Optional additions (all P2):

| Item | What it is | Cost at modelled volume | Notes |
|---|---|---|---|
| SMS reminders (Twilio) | US$0.056 per UK SMS; alphanumeric sender free | about £55 a month for 1,320 messages (confirmation + reminder) | Reminder only (660) halves it. |
| WhatsApp confirmations (Meta via a provider) | Utility template £0.0159 per message, free inside a 24-hour service window; provider adds a small per-message fee | about £21 a month plus provider fee | Needs Meta business verification; a phase of its own. |
| Stripe Terminal for walk-ins | S700 reader £229 + VAT per venue, one-off; 1.4% + 10p in person; £7 a month per reader for mobile data if not on Wi-Fi | £458 + VAT once; in-person fees slightly lower than online | Only if walk-in payments must sit inside the system; otherwise the existing card machine and "mark paid in store". |
| Vercel Pro seat for a second developer | US$20 a month | £16 | Only if someone else maintains it. |

Maintenance is the real ongoing cost: dependency and Stripe API updates, the occasional bug, Salman's own time. The 27 Sep research assumed 2–4 contractor days a month (£1,000–£2,000) for a full build; with Claude Code and a small scope, budget a few hours a month and a half-day each quarter.

For comparison (27 Sep research, two venues, same volume): Vagaro about £557 a month (no wallets online in the UK, US data storage, class deposits one rule), Square Appointments Plus about £555 (one child per class booking, classes can't be embedded). Wix today: the two projects' premium plans plus Wix Payments' UK rate on £23,700 a month; read both from the Wix billing and Payments pages for the exact figure.

## 6. Decisions (made 8 Oct 2026)

| Question | Decision | Who |
|---|---|---|
| One Stripe account or one per venue | **One Stripe account per venue**, both under one login; a key and webhook secret per venue in BayPook | Salman |
| Walk-ins | **Existing card machine or cash, recorded as a manual booking marked "paid in store"**. Stripe Terminal is a P2 adapter | Claude's pick |
| Reminders and confirmations | **Email only** at first (Resend). SMS and WhatsApp as P2 adapters | Salman |
| Lead time and cut-off | Per service, editable. Defaults: **parties 48 hours' notice, workshops until 60 minutes before the start** | Claude's pick |
| Pay in store for workshops | **Per-service toggle, default off** | Claude's pick |
| Hold while paying | **15 minutes**, editable | Claude's pick |
| Customer self-service | **None**; "message or call us". Tokens kept so it can be added later | From the 2 Oct decision |
| Refunds on customer cancellation | **Manual only**, owner's discretion in the admin | From the terms |
| Legal name, address, company number | **Settings fields**, placeholders until supplied | Claude's pick |
| Single-tenant or product | **Single-tenant for Slimedom now**, with an `organisation` record and venue-first design so it could become a product. No sign-up, no billing | Salman (MVP) + Claude's pick on shape |
| Database | **Postgres via `DATABASE_URL`** (Neon recommended, Supabase works); **PGlite** embedded for demo mode | Claude's pick |
| Email sender | `@slimedom.com` via Resend, once the domain's DNS is on Google Workspace with SPF/DKIM/DMARC | From the launch list |
| Children's data | **None for workshops**; birthday child's first name and age for parties | Claude's pick |
| Retention | **24 months**, then anonymise; editable | Claude's pick |
| Branding | Organisation name, colours, logo and contact details editable in settings; Slimedom seeded | Claude's pick |

## Sources

- Stripe UK pricing (cards, Terminal, readers, disputes, payouts, Checkout, Tax): https://stripe.com/gb/pricing
- Twilio UK SMS pricing: https://twilio.com/sms/pricing/gb
- Meta WhatsApp Business Platform pricing (per-category, free in the service window): https://developers.facebook.com/docs/whatsapp/pricing ; UK GBP rates as reported by a provider, verified Sep 2026: https://whautomate.com/whatsapp-business-api-pricing-uk
- Resend pricing: https://resend.com/pricing
- Supabase pricing: https://supabase.com/pricing
- Vercel pricing (Hobby is non-commercial): https://vercel.com/pricing
- Wix findings: project docs `booking-conflict-south-woodford.md` and `booking-conflict-build-guide.md` (Wix help and API references are listed there)
- Vendor comparison and the original custom-build estimate: `booking-platform-recommendation.md`, `booking-system-findings.md`

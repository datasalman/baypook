# Decisions the spec left open

Each entry: what was open, what BayPook does, why. Values that could change are editable in the admin.

1. **Env var names for per-venue Stripe keys.** Slugs contain hyphens, which env var names cannot. The suffix is the slug upper-cased with any non-alphanumeric run replaced by `_`: `STRIPE_SECRET_KEY__SOUTH_WOODFORD`, `STRIPE_WEBHOOK_SECRET__LAKESIDE`. The Connections page prints the exact name to set.
2. **Hold length, reminder lead and retention live on the organisation row** (Settings), not in a key/value table, so they have labelled fields and defaults (15 min, 24 h, 24 months). A `settings` key/value table exists for anything else.
3. **Opening hours are stored on the venue as JSON** (`{ mon: null | { open, close }, … }`). Timetable rules for sessions are explicit per weekday and are not gated by opening hours (the owner's rules win); slot starts are gated by opening hours. Seeded hours are flagged `openingHoursConfirmed = false` and shown as "confirm" in Settings.
4. **Session materialisation reconciles rather than regenerates.** `ensureSessions` inserts missing occurrences, updates unpinned rows that drifted (capacity, room, length), deletes unpinned rows the rules no longer produce, and pins (keeps as manual) any such row that still has bookings or holds. Admin edits to a single occurrence set `pinned = true` so later generation leaves it alone.
5. **In-store notes exist on both services and options.** The Decoden workshop note belongs to the option (one service, two options); a Decoden party's note belongs to the service. The booking page shows option notes beside the option and service notes under the total.
6. **Roles.** `users.isOwner` grants everything everywhere; non-owners have `user_venues` rows with `manager` or `staff`. Managers can refund; staff cannot. Refund permission is checked server-side in the refund action.
7. **Demo users.** `owner@demo.baypook` (owner), `manager.southwoodford@demo.baypook` (manager, South Woodford), `staff.lakeside@demo.baypook` (staff, Lakeside). The demo login page offers all three so venue scoping can be rehearsed.
8. **Live mode without a provider.** Email and calendar fall back to the demo adapter with a warning banner in the admin (nothing is dropped silently; it lands in the Outbox / Calendar log). Payments do not fall back: a venue with no Stripe key is not bookable online and `/api/v1` returns `UNAVAILABLE` for it.
9. **Google Calendar via REST + `google-auth-library`** rather than the full `googleapis` package (smaller, same API).
10. **Migrations run at runtime only in demo** (PGlite). In live mode `npm run db:migrate` (drizzle-kit) is part of the deploy command, so a cold serverless function never migrates.
11. **Payment status on bookings** is a denormalised summary (`unpaid | owed | paid | refunded | partially_refunded`) kept in step with the `payments` and `refunds` ledger, so lists and reports do not need joins.

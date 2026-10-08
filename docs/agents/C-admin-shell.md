# Agent C: admin shell, authentication, venue scoping, UI kit, Today and Week views, PWA

Read `docs/agents/COMMON.md` first and follow it.

## Files you own
- `src/server/auth.ts`, `src/server/audit.ts`, `src/server/venue-scope.ts`
- `src/components/ui/*` (the UI kit), `src/components/admin/*` (nav, venue switcher, banners)
- `src/app/(admin)/layout.tsx`, `src/app/(admin)/admin/layout.tsx`, `src/app/(admin)/admin/page.tsx` (replace the stage-0 placeholder; it becomes the Today view), `src/app/(admin)/admin/week/page.tsx`, `src/app/(admin)/admin/more/page.tsx` (a menu page listing every admin section as links, even those not built yet), `src/app/(admin)/login/page.tsx`, `src/app/(admin)/login/actions.ts`, `src/app/auth/magic/route.ts` (consumes the link), `src/app/auth/logout/route.ts`, `src/app/(admin)/admin/_lib/*` (shared loaders for admin pages)
- `src/app/layout.tsx` and `src/app/globals.css` (brand tokens from the organisation row; respect `prefers-reduced-motion`), `src/app/manifest.ts`, `public/icons/*` (generate simple PNG icons 192/512 and an SVG with a script; a plain rounded square in the brand green with a white "B" is fine), `src/app/icon.svg`
- `src/middleware.ts` is NOT yours; do auth in layouts/loaders instead.
- Tests: `tests/unit/server/auth.test.ts`
- Save a copy of this brief as `docs/agents/C-admin-shell.md`.

Other agents will later add pages under `src/app/(admin)/admin/{bookings,customers,catalogue,reports,settings,connections,outbox,calendar-log,jobs,users,audit}`. Your layout, nav and loaders must make that easy: export `requireUser`, `getAdminContext` and the UI kit; link to those routes from the nav/More page now (404 is fine until they exist).

## Auth (`src/server/auth.ts`)
Magic link by email, signed single-use 15-minute token, httpOnly session cookie.
```ts
export type CurrentUser = { id: string; email: string; name: string; isOwner: boolean; venues: { venueId: string; role: "manager" | "staff" }[] };
export async function getCurrentUser(): Promise<CurrentUser | null>;   // reads cookies(); validates session row (sha256 of the cookie token in sessions_auth.tokenHash, not expired); bumps lastSeenAt at most once per 10 minutes
export async function requireUser(): Promise<CurrentUser>;              // redirect("/login?next=…") when absent
export function canAccessVenue(u: CurrentUser, venueId: string): boolean;
export function roleAt(u: CurrentUser, venueId: string): "owner" | "manager" | "staff" | null;
export function canRefund(u: CurrentUser, venueId: string): boolean;    // owner or manager at that venue
export function canManageCatalogue(u: CurrentUser, venueId: string): boolean; // owner or manager
export function isOwner(u: CurrentUser): boolean;
export function visibleVenueIds(u: CurrentUser, allVenueIds: string[]): string[];
export async function requireVenueAccess(u: CurrentUser, venueId: string): Promise<void>; // throws AuthError("FORBIDDEN")
export async function requestMagicLink(db: Db, email: string): Promise<{ sent: boolean; link?: string }>; // user must exist and be active; token = 32 random bytes base64url; store sha256(token); expires 15 min; sends via `sendRawEmail` from `src/server/notifications` (Agent B is writing it; signature: `sendRawEmail(db, { to, subject, html, text, template: "magic_link", venueId: null })` — if that module does not exist yet when you test, create a minimal local stub inside `src/server/auth.ts` behind a dynamic import try/catch, and leave a TODO comment). In demo mode return the link too so the login page can show it.
export async function consumeMagicLink(db: Db, token: string): Promise<{ sessionToken: string; expiresAt: Date } | null>; // single use: usedAt set; creates sessions_auth (30 days); sets users.lastLoginAt
export async function signInAsDemoUser(db: Db, email: string): Promise<{ sessionToken: string; expiresAt: Date }>; // only when isDemo(); for the three seeded demo users
export async function signOut(): Promise<void>;
export const SESSION_COOKIE = "bp_session";
```
Session cookie value = `<sessionId>.<token>`; store sha256(token). Sign nothing else (the hash lookup is the check). Use `APP_SECRET` from `env.appSecret()` as an HMAC key for the magic-link token so a leaked DB row alone cannot forge a link: `tokenHash = hmac(appSecret, token)`.

Login page (`/login`): email field + "Email me a sign-in link" (server action); after submit show "Check your email" and, in demo mode, the link itself and three big buttons "Sign in as owner", "Sign in as South Woodford manager", "Sign in as Lakeside staff" (server actions calling `signInAsDemoUser` and setting the cookie, then redirect to `next` or `/admin`). `/auth/magic?token=…` consumes and redirects. `/auth/logout` clears.

## Venue scoping (`src/server/venue-scope.ts`)
Cookie `bp_venue` = venueId or `all` (owner only). `getAdminContext()` → `{ user, org, venues (visible), selectedVenueId: string | "all", selectedVenues: Venue[] , fallbackBanners: string[] }` where fallbackBanners come from `emailConfigured()` / env presence in live mode (text like "Email is not connected: messages are written to the Outbox but not sent. See Connections."). Non-owners with one venue have it selected automatically and see no switcher. Server action `selectVenue(venueId)` sets the cookie.

## Audit (`src/server/audit.ts`)
`audit(db, { user: CurrentUser | null; action: string; entityType: string; entityId?: string | null; venueId?: string | null; before?: unknown; after?: unknown })` inserts into `audit_log` (`actor` = user email or "system"). `listAudit(db, { venueIds?, limit?, search? })`.

## UI kit (`src/components/ui`)
Phone-first, one-handed, big targets (min 44px), plain words, high contrast, focus rings, reduced motion. Tailwind v4 with CSS variables `--brand`, `--ink` set in the root layout from the organisation row (fallback green `#5bbf3a` / ink `#1b1f1a`). Components (server-compatible unless noted): `Button` (variants primary/secondary/danger/ghost, sizes, `asChild`-free: accept `href` to render a Link), `Card`, `PageHeader` (title, subtitle, actions), `Field` + `Input` + `Select` + `Textarea` + `Checkbox` with labels, `Badge` (status colours: confirmed green, pending amber, cancelled grey, no_show red, owed amber, paid green), `EmptyState`, `Stat`, `SegmentedControl` (client), `ConfirmButton` (client: a button that asks "Are you sure?" inline before submitting its form; used only for money or deletion), `Toast`/flash via `?flash=` query param rendered by layout, `DateNav` (client: previous/next day or week with a date input), `BottomNav` (client: Today, Week, Bookings, More with icons), `TopBar` (title + venue switcher). Export everything from `src/components/ui/index.ts`.

## Admin layout
`src/app/(admin)/admin/layout.tsx`: `requireUser()`, `getAdminContext()`, renders TopBar (org name, venue switcher for owners), fallback warning banners (amber), `children`, BottomNav. Demo mode shows a slim "Demo mode: nothing leaves this machine" strip. `src/app/(admin)/layout.tsx` just passes through (login lives under it without the admin chrome).

## Today (`/admin`, `?date=YYYY-MM-DD`)
Per selected venue (or all, grouped by venue): a timeline list for the day: each **session** as a card with time, service name, "Places taken 3 of 10" (count pending+confirmed booking places), names of the parents booked (first name + last initial) and a "Full" badge when full; each **slot booking** (party) as a card with time range, service, birthday child, parent name and phone, paid/owed badge; **blocks** as grey cards with the reason. Materialise sessions first with `ensureVenueSessions`. Tap a session → `/admin/sessions/<id>` (you build this simple page too: the session's bookings list with links to `/admin/bookings/<id>`, and the capacity shown; actions come later from another agent, leave a clear place for them). Tap a booking → `/admin/bookings/<id>` (not yours). DateNav at the top, defaulting to today in the org timezone. A "New booking" primary button linking to `/admin/bookings/new?venue=…&date=…`.

## Week (`/admin/week`, `?start=YYYY-MM-DD`)
Seven columns on wide screens; on phones a vertical list of days with a compact row per session/party/block (time, name, places taken). Sessions with 0 taken shown muted. Links as above.

## PWA
`src/app/manifest.ts` (name from org, theme colour brand, display standalone, start_url `/admin`, icons), `<meta name="theme-color">`, apple-touch-icon. Generate the PNG icons with a small Node script using no new dependencies (write a minimal PNG encoder or use `zlib` + hand-built chunks; a 192×192 and 512×512 solid rounded-square is enough). Put the script in `scripts/make-icons.mjs` (you own that one file).

## Tests
`tests/unit/server/auth.test.ts` with `createTestDb({ seed: true })` and `process.env.BAYPOOK_MODE = "demo"`: request a magic link for `owner@demo.baypook` returns a link; consuming it once works and twice fails; an unknown email returns `{ sent: true }` without a link (no account enumeration) and creates nothing; `canRefund` matrix for the three seeded users; `visibleVenueIds`. Because `cookies()` is request-scoped, keep the pure parts testable by passing the db and tokens in explicitly.

Verify in the browser: run `npm run demo` (port 3100), open `/login`, sign in as owner, see Today with South Woodford's sessions tomorrow (`?date=` tomorrow), switch venue, sign in as Lakeside staff and confirm South Woodford is not visible. Stop the server when done (on Windows: `Get-NetTCPConnection -LocalPort 3100 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }` in PowerShell). Finish with `npm run check` green for your parts.

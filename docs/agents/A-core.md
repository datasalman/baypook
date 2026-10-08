# Agent A: core rules, availability, pricing and holds

Read `docs/agents/COMMON.md` first and follow it.

## Files you own
- `src/core/availability.ts`, `src/core/pricing.ts`, `src/core/booking-state.ts`, `src/core/reference.ts`, `src/core/index.ts` (barrel). You may ADD tests and small helpers to `src/core/time.ts` and `src/core/timetable.ts` but keep their existing exports working.
- `src/server/catalogue.ts`, `src/server/availability.ts`, `src/server/holds.ts`, `src/server/quote.ts`
- Tests: `tests/unit/core/*.test.ts`, `tests/unit/server/holds.test.ts`, `tests/unit/server/availability.test.ts`
- Save a copy of this brief as `docs/agents/A-core.md`.

## What to build

### 1. `src/core/pricing.ts` (pure)
```ts
export class PricingError extends Error { code: "INVALID" | "LIMIT"; limit?: number }
export type OptionLike = { id: string; name: string; unitPricePence: number; includedChildren: number | null; maxPerBooking: number | null; archivedAt: Date | null; inStoreNoteShort: string | null };
export type AddOnLike = { id: string; name: string; pricePence: number; kind: "quantity" | "time"; extraMinutes: number; maxQuantity: number; perChild: boolean; archivedAt: Date | null };
export type QuoteInput = { serviceKind: "session" | "slot"; options: OptionLike[]; addOns: AddOnLike[]; lines: { optionId: string; qty: number }[]; addOnSelections: { addOnId: string; qty: number }[]; maxPlacesPerBooking: number; serviceInStoreNoteShort?: string | null };
export type Quote = { lines: BookingLine[]; addOns: BookingAddOn[]; subtotalPence: number; totalPence: number; places: number; extraMinutes: number; inStoreNotes: string[] };
export function quote(input: QuoteInput): Quote;
```
(`BookingLine`, `BookingAddOn` types come from `src/db/schema.ts`.) Rules: qty integers >= 0, at least one line with qty > 0, unknown or archived option/add-on -> INVALID. Sessions: `places` = sum of qty; `places > maxPlacesPerBooking` -> LIMIT with `limit`; option `maxPerBooking` -> LIMIT. Slots: exactly one option line with qty 1 (the package); `places` = includedChildren + sum of per-child add-on qty; per-child add-on qty > maxQuantity -> LIMIT with limit = includedChildren + maxQuantity (the max children); any add-on qty > maxQuantity -> LIMIT; time add-ons add `extraMinutes`. Total = sum of lines + sum of add-ons. `inStoreNotes` = distinct non-empty `inStoreNoteShort` of chosen options plus the service note. Never trust client totals.

### 2. `src/core/availability.ts` (pure)
```ts
export type BookingLike = { id: string; roomId: string; sessionId: string | null; startsAt: Date; endsAt: Date; places: number; serviceKind: "session" | "slot"; status: "pending" | "confirmed" };
export type HoldLike = { id: string; roomId: string; sessionId: string | null; startsAt: Date; endsAt: Date; places: number; serviceKind: "session" | "slot"; expiresAt: Date };
export type BlockLike = { roomId: string | null; startsAt: Date; endsAt: Date };
export type SessionLike = { id: string; roomId: string; startsAt: Date; endsAt: Date; capacity: number; status: "scheduled" | "cancelled" };
export type ServiceRules = { id: string; kind: "session" | "slot"; roomId: string; lengthMinutes: number; slotIntervalMinutes: number; leadTimeMinutes: number; cutoffMinutes: number };
export type VenueRules = { status: "open" | "opening" | "closed"; opensAt: Date | null; openingHours: OpeningHours };
export type NotBookableReason = "full" | "cutoff" | "lead_time" | "blocked" | "room_busy" | "past" | "cancelled" | "closed";
export type SessionAvailability = { sessionId: string; startsAt: Date; endsAt: Date; capacity: number; taken: number; held: number; remaining: number; bookable: boolean; reason: NotBookableReason | null };
export type SlotStart = { startsAt: Date; endsAt: Date; bookable: boolean; reason: NotBookableReason | null };

export function computeSessionAvailability(input: { now: Date; service: ServiceRules; venue: VenueRules; sessions: SessionLike[]; bookings: BookingLike[]; holds: HoldLike[]; blocks: BlockLike[]; excludeBookingId?: string; excludeHoldId?: string; ignoreTiming?: boolean }): SessionAvailability[];
export function computeSlotStarts(input: { now: Date; day: string; service: ServiceRules; venue: VenueRules; sessions: SessionLike[]; bookings: BookingLike[]; holds: HoldLike[]; blocks: BlockLike[]; extraMinutes: number; tz?: string; excludeBookingId?: string; excludeHoldId?: string; ignoreTiming?: boolean }): SlotStart[];
export function isSlotBookable(input: { now: Date; startsAt: Date; endsAt: Date; service: ServiceRules; venue: VenueRules; sessions: SessionLike[]; bookings: BookingLike[]; holds: HoldLike[]; blocks: BlockLike[]; tz?: string; excludeBookingId?: string; excludeHoldId?: string; ignoreTiming?: boolean }): { bookable: boolean; reason: NotBookableReason | null };
```
Rules (from the build prompt, section "Core rules"):
- A session is bookable if: `startsAt - now >= leadTimeMinutes` and `startsAt - now >= cutoffMinutes` (else `lead_time`/`cutoff`; `past` when startsAt <= now), status scheduled, not overlapping a block (venue-wide `roomId null` or same room), remaining = capacity - confirmed/pending booking places - live hold places (holds with expiresAt > now) > 0, and no confirmed/pending or held **slot** booking overlaps it in the same room (`room_busy`). `taken` counts pending+confirmed booking places; `held` counts live holds. `ignoreTiming` skips lead/cutoff (admin manual bookings). `excludeBookingId`/`excludeHoldId` skip one booking/hold (for moves and re-checks).
- A slot start is bookable if: timing as above; the venue is not closed and startsAt >= opensAt when set; the whole `[startsAt, startsAt + lengthMinutes + extraMinutes)` lies within that day's opening hours (`closed` reason when the day has no hours); no block overlaps; no confirmed/pending/held slot booking overlaps in the same room; and no **session with at least one confirmed/pending/held place** overlaps in the same room (an empty session does not block a slot). Count session places from bookings/holds with that `sessionId`.
- `computeSlotStarts` generates candidate starts every `slotIntervalMinutes` from opening to the last start that fits, for `day` ('YYYY-MM-DD' local); returns every candidate with bookable flag and reason (the API filters to bookable ones).
- Overlap is half-open (`overlaps()` in `src/core/time.ts`). Use London helpers; never `new Date(y,m,d)` local maths.

### 3. `src/core/booking-state.ts` (pure)
`type BookingStatus = "pending"|"confirmed"|"cancelled"|"no_show"`; `canTransition(from, to)`; `assertTransition(from, to)` throwing `BookingStateError`. Allowed: pending->confirmed, pending->cancelled, confirmed->cancelled, confirmed->no_show, no_show->confirmed (undo), cancelled->confirmed (admin reinstates; the caller re-checks availability).

### 4. `src/core/reference.ts`
`generateReference(random = crypto)` -> `BP-` + 5 chars from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`; `generateToken()` -> 32 bytes base64url via `node:crypto`. Pure except for randomness; accept an injectable random source for tests.

### 5. `src/server/catalogue.ts`
```ts
export type ServiceWithCatalogue = s.Service & { options: s.ServiceOption[]; addOns: s.AddOn[]; room: s.Room };
export async function listServicesForVenue(db: DbOrTx, venueId: string, opts?: { includeArchived?: boolean; onlineOnly?: boolean }): Promise<ServiceWithCatalogue[]>;  // sorted by sortOrder; options/addOns sorted, archived filtered unless includeArchived
export async function getService(db: DbOrTx, serviceId: string, opts?: { includeArchived?: boolean }): Promise<ServiceWithCatalogue | null>;
export async function getServiceBySlug(db: DbOrTx, venueId: string, slug: string): Promise<ServiceWithCatalogue | null>;
```

### 6. `src/server/quote.ts`
`quoteForService(db, { service: ServiceWithCatalogue; venue: s.Venue; lines; addOns }): Quote` (pure wrapper that maps DB rows into `quote()`); export `toQuoteInput`.

### 7. `src/server/availability.ts`
```ts
export async function loadWindowState(db: DbOrTx, input: { venueId: string; roomId?: string; from: Date; to: Date; now: Date }): Promise<{ sessions: SessionLike[]; bookings: BookingLike[]; holds: HoldLike[]; blocks: BlockLike[] }>;  // bookings status in (pending, confirmed) overlapping the window, holds active & not expired, blocks overlapping, sessions scheduled|cancelled in window; include the service kind via join to services
export async function getSessionAvailability(db: DbOrTx, input: { venue: s.Venue; service: ServiceWithCatalogue; from: string; to: string; now?: Date; tz?: string }): Promise<SessionAvailability[]>;  // calls ensureSessions(db, service, venue, from, to, tz) first, then computeSessionAvailability
export async function getSlotStarts(db: DbOrTx, input: { venue: s.Venue; service: ServiceWithCatalogue; day: string; extraMinutes: number; now?: Date; tz?: string }): Promise<SlotStart[]>;  // ensure sessions for the venue's session services that day (ensureVenueSessions) so room conflicts are visible
export async function assertBookable(tx: DbOrTx, input: { venue: s.Venue; service: ServiceWithCatalogue; sessionId?: string | null; startsAt: Date; endsAt: Date; places: number; now?: Date; excludeBookingId?: string; excludeHoldId?: string; ignoreTiming?: boolean }): Promise<{ sessionId: string | null; startsAt: Date; endsAt: Date }>;  // throws AvailabilityError { code: "GONE" | "LIMIT" | "INVALID"; reason?: NotBookableReason; limit?: number }
```
`assertBookable` is the single conflict rule used by holds, manual bookings and moves. For sessions it checks remaining >= places; for slots `isSlotBookable`. Use `SELECT ... FOR UPDATE` on the session row (sessions) or the room row (slots) via Drizzle's `.for("update")` so concurrent holds serialise; PGlite accepts it.

### 8. `src/server/holds.ts`
```ts
export class HoldError extends Error { code: "GONE" | "LIMIT" | "INVALID" | "HOLD_EXPIRED" | "NOT_FOUND"; limit?: number; reason?: NotBookableReason }
export async function createHold(db: Db, input: { venue: s.Venue; service: ServiceWithCatalogue; holdMinutes: number; sessionId?: string | null; startsAt?: Date | null; lines: { optionId: string; qty: number }[]; addOns: { addOnId: string; qty: number }[]; now?: Date }): Promise<{ hold: s.Hold; quote: Quote }>;
```
Inside one `db.transaction`: quote (map PricingError -> HoldError), compute `endsAt = startsAt + lengthMinutes + quote.extraMinutes` (sessions: use the session's own start/end), `assertBookable`, insert the hold (`places = quote.places`, `expiresAt = now + holdMinutes`). Also:
`getHold(db, id, now?)` -> hold or null; `getActiveHold(db, id, now?)` -> throws HOLD_EXPIRED when expired/not active, NOT_FOUND when missing; `markHoldConverted(tx, holdId, bookingId)`, `releaseHold(db, holdId)` (status released), `expireHolds(db, now?)` -> `{ expired: number; checkoutIds: string[]; bookingIds: string[] }` (sets status expired for active holds past expiry; the caller cancels pending bookings and tells the payment provider), `extendHold(db, holdId, minutes)`.

### 9. Tests (Vitest), >= 90% line coverage of `src/core` (`npm run test:coverage` prints it; the thresholds in `vitest.config.mts` must pass)
Must include: the BST->GMT weekend (Sat 24 / Sun 25 Oct 2026: a 10:00 session is 09:00Z on Saturday and 10:00Z on Sunday; a slot that spans 01:00-02:00 Sunday is not a business case, just prove day boundaries hold); overlap edges (16:00 end vs 16:00 start on both sides); the empty-session-gives-way rule (empty workshop session does not block a party; one booked place does; a held place does; an expired hold does not); a party blocks the sessions it overlaps and a Food-time party (120 min) blocks one more; Lakeside party room does not cross-block the workshop floor; lead time (48 h) and cut-off (60 min) edges at exactly the boundary (bookable when equal); capacity with pending+confirmed+held; per-child add-on pricing with included counts (Slime Party + 3 extra = £248, 11 extra -> LIMIT limit 20); LIMIT on max places per booking (11 places -> limit 10); state machine table; reference alphabet/length; and DB-level tests using `createTestDb({ seed: true })`: `createHold` twice on the last place -> second GONE; expired holds ignored and expired by `expireHolds`; `assertBookable` with `excludeBookingId`.

Finish with `npm run check` and `npm run test:coverage` green for your parts. Report any contract deviations precisely in your final message.

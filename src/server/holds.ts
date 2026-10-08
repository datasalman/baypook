/**
 * Holds: places or a slot kept for a customer while they pay.
 *
 * Lifecycle: active -> converted (booking confirmed) | released (payment failed or
 * declined) | expired (hold time ran out; `expireHolds`, run by cron).
 * While a hold is active and has no `bookingId`, availability counts its places.
 * Once checkout creates the pending booking it should call `attachHoldToBooking`;
 * from then on the pending booking counts the places and the hold is the expiry timer.
 */
import { and, eq, lte } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db";
import * as s from "@/db/schema";
import type { NotBookableReason } from "@/core/availability";
import { PricingError, type Quote } from "@/core/pricing";
import { addMinutes } from "@/core/time";
import { AvailabilityError, assertBookable } from "./availability";
import { isUuid, type ServiceWithCatalogue } from "./catalogue";
import { quoteForService } from "./quote";

export type HoldErrorCode = "GONE" | "LIMIT" | "INVALID" | "HOLD_EXPIRED" | "NOT_FOUND";

export class HoldError extends Error {
  code: HoldErrorCode;
  limit?: number;
  reason?: NotBookableReason;
  constructor(code: HoldErrorCode, message: string, extra: { limit?: number; reason?: NotBookableReason } = {}) {
    super(message);
    this.name = "HoldError";
    this.code = code;
    if (extra.limit !== undefined) this.limit = extra.limit;
    if (extra.reason) this.reason = extra.reason;
  }
}

function toHoldError(e: unknown): unknown {
  if (e instanceof PricingError) return new HoldError(e.code, e.message, { limit: e.limit });
  if (e instanceof AvailabilityError) return new HoldError(e.code, e.message, { limit: e.limit, reason: e.reason });
  return e;
}

export async function createHold(
  db: Db,
  input: {
    venue: s.Venue;
    service: ServiceWithCatalogue;
    holdMinutes: number;
    sessionId?: string | null;
    startsAt?: Date | null;
    lines: { optionId: string; qty: number }[];
    addOns: { addOnId: string; qty: number }[];
    now?: Date;
    tz?: string;
  },
): Promise<{ hold: s.Hold; quote: Quote }> {
  const { venue, service } = input;
  const now = input.now ?? new Date();
  if (service.venueId !== venue.id) throw new HoldError("INVALID", "That service is not offered at this venue.");
  if (service.archivedAt) throw new HoldError("INVALID", "That service is no longer available.");

  try {
    return await db.transaction(async (tx) => {
      const q = quoteForService(tx, { service, venue, lines: input.lines, addOns: input.addOns });

      let startsAt: Date;
      let endsAt: Date;
      if (service.kind === "session") {
        if (!input.sessionId) throw new HoldError("INVALID", "Choose a session time.");
        // The session's own times are used; these are placeholders until assertBookable returns them.
        startsAt = now;
        endsAt = now;
      } else {
        const st = input.startsAt;
        if (!(st instanceof Date) || Number.isNaN(st.getTime())) throw new HoldError("INVALID", "Choose a start time.");
        startsAt = st;
        endsAt = addMinutes(st, service.lengthMinutes + q.extraMinutes);
      }

      const slot = await assertBookable(tx, {
        venue,
        service,
        sessionId: service.kind === "session" ? input.sessionId : null,
        startsAt,
        endsAt,
        places: q.places,
        now,
        tz: input.tz,
      });

      // A session keeps its own room (it may be pinned in an old room after the service moved).
      let roomId = service.roomId;
      if (slot.sessionId) {
        const [session] = await tx.select({ roomId: s.sessions.roomId }).from(s.sessions).where(eq(s.sessions.id, slot.sessionId)).limit(1);
        if (session) roomId = session.roomId;
      }

      const [hold] = await tx
        .insert(s.holds)
        .values({
          venueId: venue.id,
          serviceId: service.id,
          roomId,
          sessionId: slot.sessionId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          lines: q.lines.map((l) => ({ optionId: l.optionId, qty: l.qty })),
          addOns: q.addOns.map((a) => ({ addOnId: a.addOnId, qty: a.qty })),
          places: q.places,
          expiresAt: addMinutes(now, input.holdMinutes),
          status: "active",
        })
        .returning();
      return { hold, quote: q };
    });
  } catch (e) {
    throw toHoldError(e);
  }
}

/** The hold row, whatever its status, or null. */
export async function getHold(db: DbOrTx, id: string, _now?: Date): Promise<s.Hold | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(s.holds).where(eq(s.holds.id, id)).limit(1);
  return row ?? null;
}

/** An active, unexpired hold. Throws NOT_FOUND when missing, HOLD_EXPIRED when lapsed or no longer active. */
export async function getActiveHold(db: DbOrTx, id: string, now: Date = new Date()): Promise<s.Hold> {
  const hold = await getHold(db, id);
  if (!hold) throw new HoldError("NOT_FOUND", "We could not find that booking in progress.");
  if (hold.status !== "active" || hold.expiresAt.getTime() <= now.getTime()) {
    throw new HoldError("HOLD_EXPIRED", "Your places were held for a short time and that time has run out. Please choose a time again.");
  }
  return hold;
}

/**
 * Lock the hold row (`SELECT ... FOR UPDATE`) inside a transaction and check it is
 * still active and unexpired. Concurrent checkouts on one hold serialise here, and
 * the second sees the first one's changes. Throws like `getActiveHold`.
 */
export async function lockActiveHold(tx: DbOrTx, id: string, now: Date = new Date()): Promise<s.Hold> {
  if (!isUuid(id)) throw new HoldError("NOT_FOUND", "We could not find that booking in progress.");
  const [hold] = await tx.select().from(s.holds).where(eq(s.holds.id, id)).for("update");
  if (!hold) throw new HoldError("NOT_FOUND", "We could not find that booking in progress.");
  if (hold.status !== "active" || hold.expiresAt.getTime() <= now.getTime()) {
    throw new HoldError("HOLD_EXPIRED", "Your places were held for a short time and that time has run out. Please choose a time again.");
  }
  return hold;
}

/**
 * Link an active hold to the pending booking (and checkout) created from it. The hold
 * stays active as the expiry timer; availability stops counting it so the pending
 * booking's places are not counted twice.
 */
export async function attachHoldToBooking(
  tx: DbOrTx,
  holdId: string,
  input: { bookingId: string; checkoutId?: string | null },
): Promise<void> {
  await tx
    .update(s.holds)
    .set({ bookingId: input.bookingId, ...(input.checkoutId !== undefined ? { checkoutId: input.checkoutId } : {}) })
    .where(eq(s.holds.id, holdId));
}

/** Store the payment provider's checkout id on the hold. */
export async function setHoldCheckout(tx: DbOrTx, holdId: string, checkoutId: string): Promise<void> {
  await tx.update(s.holds).set({ checkoutId }).where(eq(s.holds.id, holdId));
}

/** The booking is confirmed: the hold has done its job. */
export async function markHoldConverted(tx: DbOrTx, holdId: string, bookingId: string): Promise<void> {
  await tx.update(s.holds).set({ status: "converted", bookingId }).where(eq(s.holds.id, holdId));
}

/** Give the places back now (payment declined or abandoned). Only active holds change. */
export async function releaseHold(db: DbOrTx, holdId: string): Promise<boolean> {
  if (!isUuid(holdId)) return false;
  const rows = await db
    .update(s.holds)
    .set({ status: "released" })
    .where(and(eq(s.holds.id, holdId), eq(s.holds.status, "active")))
    .returning({ id: s.holds.id });
  return rows.length > 0;
}

/**
 * Mark every active hold past its expiry as expired. Returns the checkout ids and
 * pending booking ids attached to them: the caller cancels those bookings and
 * expires the checkouts with the payment provider.
 */
export async function expireHolds(
  db: DbOrTx,
  now: Date = new Date(),
): Promise<{ expired: number; checkoutIds: string[]; bookingIds: string[] }> {
  const rows = await db
    .update(s.holds)
    .set({ status: "expired" })
    .where(and(eq(s.holds.status, "active"), lte(s.holds.expiresAt, now)))
    .returning({ id: s.holds.id, checkoutId: s.holds.checkoutId, bookingId: s.holds.bookingId });
  return {
    expired: rows.length,
    checkoutIds: rows.map((r) => r.checkoutId).filter((x): x is string => Boolean(x)),
    bookingIds: rows.map((r) => r.bookingId).filter((x): x is string => Boolean(x)),
  };
}

/** Push an active hold's expiry `minutes` later (e.g. to cover a payment page's own expiry). */
export async function extendHold(db: DbOrTx, holdId: string, minutes: number): Promise<s.Hold | null> {
  const hold = await getHold(db, holdId);
  if (!hold || hold.status !== "active") return null;
  const [row] = await db
    .update(s.holds)
    .set({ expiresAt: addMinutes(hold.expiresAt, minutes) })
    .where(and(eq(s.holds.id, holdId), eq(s.holds.status, "active"), eq(s.holds.expiresAt, hold.expiresAt)))
    .returning();
  return row ?? null;
}

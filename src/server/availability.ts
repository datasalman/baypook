/**
 * Availability against the database: loads the state of a room/venue window and
 * runs the pure rules from `@/core/availability`. `assertBookable` is the single
 * conflict check used by holds, manual bookings and moves; it locks the session
 * and room rows (`SELECT ... FOR UPDATE`) so concurrent attempts serialise.
 */
import { and, eq, gt, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import {
  computeSessionAvailability,
  computeSlotStarts,
  isSlotBookable,
  type BlockLike,
  type BookingLike,
  type HoldLike,
  type NotBookableReason,
  type ServiceRules,
  type SessionAvailability,
  type SessionLike,
  type SlotStart,
  type VenueRules,
} from "@/core/availability";
import { DEFAULT_TZ, endOfLocalDay, startOfLocalDay } from "@/core/time";
import { ensureSessions, ensureVenueSessions } from "./sessions";
import { isUuid, type ServiceWithCatalogue } from "./catalogue";

export type AvailabilityErrorCode = "GONE" | "LIMIT" | "INVALID";

export class AvailabilityError extends Error {
  code: AvailabilityErrorCode;
  reason?: NotBookableReason;
  limit?: number;
  constructor(code: AvailabilityErrorCode, message: string, extra: { reason?: NotBookableReason; limit?: number } = {}) {
    super(message);
    this.name = "AvailabilityError";
    this.code = code;
    if (extra.reason) this.reason = extra.reason;
    if (extra.limit !== undefined) this.limit = extra.limit;
  }
}

export type WindowState = { sessions: SessionLike[]; bookings: BookingLike[]; holds: HoldLike[]; blocks: BlockLike[] };

export function toServiceRules(service: s.Service): ServiceRules {
  return {
    id: service.id,
    kind: service.kind,
    roomId: service.roomId,
    lengthMinutes: service.lengthMinutes,
    slotIntervalMinutes: service.slotIntervalMinutes,
    leadTimeMinutes: service.leadTimeMinutes,
    cutoffMinutes: service.cutoffMinutes,
  };
}

export function toVenueRules(venue: s.Venue): VenueRules {
  return { status: venue.status, opensAt: venue.opensAt, openingHours: venue.openingHours };
}

function toSessionLike(
  row: Pick<s.Session, "id" | "serviceId" | "roomId" | "startsAt" | "endsAt" | "capacity" | "status">,
): SessionLike {
  return {
    id: row.id,
    serviceId: row.serviceId,
    roomId: row.roomId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    capacity: row.capacity,
    status: row.status,
  };
}

/**
 * Everything that can conflict inside [from, to) at a venue (optionally one room):
 * - sessions (scheduled or cancelled) overlapping the window
 * - pending and confirmed bookings overlapping the window
 * - active, unexpired holds overlapping the window that are not yet attached to a
 *   booking (once checkout creates the pending booking and sets `holds.bookingId`,
 *   the booking counts the places, so they are never counted twice)
 * - blocks overlapping the window (venue-wide, or the room when one is given)
 */
export async function loadWindowState(
  db: DbOrTx,
  input: { venueId: string; roomId?: string; from: Date; to: Date; now: Date },
): Promise<WindowState> {
  const { venueId, roomId, from, to, now } = input;

  const sessionConds: SQL[] = [eq(s.sessions.venueId, venueId), lt(s.sessions.startsAt, to), gt(s.sessions.endsAt, from)];
  if (roomId) sessionConds.push(eq(s.sessions.roomId, roomId));

  const bookingConds: SQL[] = [
    eq(s.bookings.venueId, venueId),
    inArray(s.bookings.status, ["pending", "confirmed"]),
    lt(s.bookings.startsAt, to),
    gt(s.bookings.endsAt, from),
  ];
  if (roomId) bookingConds.push(eq(s.bookings.roomId, roomId));

  const holdConds: SQL[] = [
    eq(s.holds.venueId, venueId),
    eq(s.holds.status, "active"),
    gt(s.holds.expiresAt, now),
    isNull(s.holds.bookingId),
    lt(s.holds.startsAt, to),
    gt(s.holds.endsAt, from),
  ];
  if (roomId) holdConds.push(eq(s.holds.roomId, roomId));

  const blockConds: (SQL | undefined)[] = [eq(s.blocks.venueId, venueId), lt(s.blocks.startsAt, to), gt(s.blocks.endsAt, from)];
  if (roomId) blockConds.push(or(isNull(s.blocks.roomId), eq(s.blocks.roomId, roomId)));

  const sessionRows = await db
    .select({
      id: s.sessions.id,
      serviceId: s.sessions.serviceId,
      roomId: s.sessions.roomId,
      startsAt: s.sessions.startsAt,
      endsAt: s.sessions.endsAt,
      capacity: s.sessions.capacity,
      status: s.sessions.status,
    })
    .from(s.sessions)
    .where(and(...sessionConds));

  const bookingRows = await db
    .select({
      id: s.bookings.id,
      roomId: s.bookings.roomId,
      sessionId: s.bookings.sessionId,
      startsAt: s.bookings.startsAt,
      endsAt: s.bookings.endsAt,
      places: s.bookings.places,
      status: s.bookings.status,
      serviceKind: s.services.kind,
    })
    .from(s.bookings)
    .innerJoin(s.services, eq(s.services.id, s.bookings.serviceId))
    .where(and(...bookingConds));

  const holdRows = await db
    .select({
      id: s.holds.id,
      roomId: s.holds.roomId,
      sessionId: s.holds.sessionId,
      startsAt: s.holds.startsAt,
      endsAt: s.holds.endsAt,
      places: s.holds.places,
      expiresAt: s.holds.expiresAt,
      serviceKind: s.services.kind,
    })
    .from(s.holds)
    .innerJoin(s.services, eq(s.services.id, s.holds.serviceId))
    .where(and(...holdConds));

  const blockRows = await db
    .select({ roomId: s.blocks.roomId, startsAt: s.blocks.startsAt, endsAt: s.blocks.endsAt })
    .from(s.blocks)
    .where(and(...blockConds));

  const bookings: BookingLike[] = [];
  for (const b of bookingRows) {
    if (b.status === "pending" || b.status === "confirmed") bookings.push({ ...b, status: b.status });
  }

  return { sessions: sessionRows.map(toSessionLike), bookings, holds: holdRows, blocks: blockRows };
}

/** Session availability for a service between two local dates (inclusive). Materialises sessions first. */
export async function getSessionAvailability(
  db: DbOrTx,
  input: { venue: s.Venue; service: ServiceWithCatalogue; from: string; to: string; now?: Date; tz?: string },
): Promise<SessionAvailability[]> {
  const { venue, service } = input;
  if (service.kind !== "session") return [];
  const tz = input.tz ?? DEFAULT_TZ;
  const now = input.now ?? new Date();
  await ensureSessions(db, service, venue, input.from, input.to, tz);
  const from = startOfLocalDay(input.from, tz);
  const to = endOfLocalDay(input.to, tz);
  const state = await loadWindowState(db, { venueId: venue.id, roomId: service.roomId, from, to, now });
  const sessions = state.sessions.filter(
    (x) => x.serviceId === service.id && x.startsAt.getTime() >= from.getTime() && x.startsAt.getTime() < to.getTime(),
  );
  return computeSessionAvailability({
    now,
    service: toServiceRules(service),
    venue: toVenueRules(venue),
    ...state,
    sessions,
  });
}

/** Every candidate slot start on a local day, with a bookable flag and reason (filter to `bookable` for customers). */
export async function getSlotStarts(
  db: DbOrTx,
  input: { venue: s.Venue; service: ServiceWithCatalogue; day: string; extraMinutes: number; now?: Date; tz?: string },
): Promise<SlotStart[]> {
  const { venue, service, day } = input;
  if (service.kind !== "slot") return [];
  const tz = input.tz ?? DEFAULT_TZ;
  const now = input.now ?? new Date();
  // Sessions in the same room must exist as rows for their bookings to be seen as conflicts.
  await ensureVenueSessions(db, venue.id, day, day, tz);
  const state = await loadWindowState(db, {
    venueId: venue.id,
    roomId: service.roomId,
    from: startOfLocalDay(day, tz),
    to: endOfLocalDay(day, tz),
    now,
  });
  return computeSlotStarts({
    now,
    day,
    service: toServiceRules(service),
    venue: toVenueRules(venue),
    ...state,
    extraMinutes: input.extraMinutes,
    tz,
  });
}

export const NOT_BOOKABLE_MESSAGES: Record<NotBookableReason, string> = {
  full: "That time is now full.",
  cutoff: "That time is too close to the start to book online.",
  lead_time: "That time needs more notice to book.",
  blocked: "That time is not available.",
  room_busy: "That time is no longer available.",
  past: "That time has already started.",
  cancelled: "That session has been cancelled.",
  closed: "We are closed at that time.",
};

/**
 * The single conflict rule for holds, manual bookings and moves. Call inside a transaction.
 * Sessions: the session must be bookable and have at least `places` remaining
 * (none left -> GONE "full"; some but fewer than asked -> LIMIT with `limit` = remaining).
 * Slots: `isSlotBookable` over [startsAt, endsAt) (the caller adds time add-ons to endsAt).
 * Returns the interval to store (for sessions, the session's own start and end).
 */
export async function assertBookable(
  tx: DbOrTx,
  input: {
    venue: s.Venue;
    service: ServiceWithCatalogue;
    sessionId?: string | null;
    startsAt: Date;
    endsAt: Date;
    places: number;
    now?: Date;
    tz?: string;
    excludeBookingId?: string;
    excludeHoldId?: string;
    ignoreTiming?: boolean;
  },
): Promise<{ sessionId: string | null; startsAt: Date; endsAt: Date }> {
  const { venue, service } = input;
  const now = input.now ?? new Date();
  const tz = input.tz ?? DEFAULT_TZ;
  if (service.venueId !== venue.id) throw new AvailabilityError("INVALID", "That service is not offered at this venue.");
  if (!Number.isInteger(input.places) || input.places < 1) throw new AvailabilityError("INVALID", "Choose at least one place.");
  const common = {
    now,
    service: toServiceRules(service),
    venue: toVenueRules(venue),
    excludeBookingId: input.excludeBookingId,
    excludeHoldId: input.excludeHoldId,
    ignoreTiming: input.ignoreTiming,
  };

  if (service.kind === "session") {
    if (!isUuid(input.sessionId)) throw new AvailabilityError("INVALID", "Choose a session time.");
    // Lock order everywhere: session row (if any), then room row.
    const [session] = await tx.select().from(s.sessions).where(eq(s.sessions.id, input.sessionId)).for("update");
    if (!session || session.serviceId !== service.id) {
      throw new AvailabilityError("INVALID", "That session is not part of this service.");
    }
    await tx.select({ id: s.rooms.id }).from(s.rooms).where(eq(s.rooms.id, session.roomId)).for("update");

    const state = await loadWindowState(tx, {
      venueId: venue.id,
      roomId: session.roomId,
      from: session.startsAt,
      to: session.endsAt,
      now,
    });
    const [a] = computeSessionAvailability({ ...common, ...state, sessions: [toSessionLike(session)] });
    if (a.reason && a.reason !== "full") {
      throw new AvailabilityError("GONE", NOT_BOOKABLE_MESSAGES[a.reason], { reason: a.reason });
    }
    if (a.remaining <= 0) throw new AvailabilityError("GONE", NOT_BOOKABLE_MESSAGES.full, { reason: "full", limit: 0 });
    if (a.remaining < input.places) {
      throw new AvailabilityError("LIMIT", `Only ${a.remaining} ${a.remaining === 1 ? "place" : "places"} left at this time.`, {
        reason: "full",
        limit: a.remaining,
      });
    }
    return { sessionId: session.id, startsAt: session.startsAt, endsAt: session.endsAt };
  }

  const { startsAt, endsAt } = input;
  if (!(startsAt instanceof Date) || Number.isNaN(startsAt.getTime()) || !(endsAt instanceof Date) || endsAt <= startsAt) {
    throw new AvailabilityError("INVALID", "Choose a start time.");
  }
  await tx.select({ id: s.rooms.id }).from(s.rooms).where(eq(s.rooms.id, service.roomId)).for("update");
  const state = await loadWindowState(tx, { venueId: venue.id, roomId: service.roomId, from: startsAt, to: endsAt, now });
  const r = isSlotBookable({ ...common, ...state, startsAt, endsAt, tz });
  if (r.reason) throw new AvailabilityError("GONE", NOT_BOOKABLE_MESSAGES[r.reason], { reason: r.reason });
  return { sessionId: null, startsAt, endsAt };
}

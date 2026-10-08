/**
 * Availability: the single conflict rule for sessions (workshops) and slots (parties).
 * Pure. Instants are UTC Dates; days and opening hours are evaluated in the
 * organisation timezone (Europe/London by default).
 *
 * Room rule: in one room, a slot booking blocks every session it overlaps, and a
 * session blocks an overlapping slot only once it has at least one place taken
 * or held (an empty session gives way to a party). Different rooms never
 * cross-block. Overlap is half-open, so a 16:00 end never meets a 16:00 start.
 */
import type { OpeningHours } from "@/db/schema";
import { addMinutes, DEFAULT_TZ, localDate, overlaps, startOfLocalDay, weekdayKey, zonedDateTime } from "./time";

export type BookingLike = {
  id: string;
  roomId: string;
  sessionId: string | null;
  startsAt: Date;
  endsAt: Date;
  places: number;
  serviceKind: "session" | "slot";
  status: "pending" | "confirmed";
};

export type HoldLike = {
  id: string;
  roomId: string;
  sessionId: string | null;
  startsAt: Date;
  endsAt: Date;
  places: number;
  serviceKind: "session" | "slot";
  expiresAt: Date;
};

export type BlockLike = { roomId: string | null; startsAt: Date; endsAt: Date };

export type SessionLike = {
  id: string;
  roomId: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  status: "scheduled" | "cancelled";
  /** Optional: when present, `computeSessionAvailability` only reports this service's sessions. */
  serviceId?: string;
};

export type ServiceRules = {
  id: string;
  kind: "session" | "slot";
  roomId: string;
  lengthMinutes: number;
  slotIntervalMinutes: number;
  leadTimeMinutes: number;
  cutoffMinutes: number;
};

export type VenueRules = {
  status: "open" | "opening" | "closed";
  opensAt: Date | null;
  openingHours: OpeningHours;
};

export type NotBookableReason = "full" | "cutoff" | "lead_time" | "blocked" | "room_busy" | "past" | "cancelled" | "closed";

export type SessionAvailability = {
  sessionId: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  /** Places on pending and confirmed bookings. */
  taken: number;
  /** Places on live holds. */
  held: number;
  remaining: number;
  bookable: boolean;
  reason: NotBookableReason | null;
};

export type SlotStart = { startsAt: Date; endsAt: Date; bookable: boolean; reason: NotBookableReason | null };

type StateInput = {
  now: Date;
  service: ServiceRules;
  venue: VenueRules;
  sessions: SessionLike[];
  bookings: BookingLike[];
  holds: HoldLike[];
  blocks: BlockLike[];
  excludeBookingId?: string;
  excludeHoldId?: string;
  ignoreTiming?: boolean;
};

export type SessionAvailabilityInput = StateInput;

export type SlotStartsInput = StateInput & { day: string; extraMinutes: number; tz?: string };

export type SlotCheckInput = StateInput & { startsAt: Date; endsAt: Date; tz?: string };

// ---------- shared helpers ----------

/** Lead time and cut-off: bookable when the start is at least that many minutes away (equal is fine). */
export function timingReason(
  now: Date,
  startsAt: Date,
  service: Pick<ServiceRules, "leadTimeMinutes" | "cutoffMinutes">,
  ignoreTiming = false,
): NotBookableReason | null {
  if (ignoreTiming) return null;
  const msUntil = startsAt.getTime() - now.getTime();
  if (msUntil <= 0) return "past";
  if (msUntil < service.leadTimeMinutes * 60_000) return "lead_time";
  if (msUntil < service.cutoffMinutes * 60_000) return "cutoff";
  return null;
}

/** Venue status and opening date. */
function venueReason(venue: VenueRules, startsAt: Date): NotBookableReason | null {
  if (venue.status === "closed") return "closed";
  if (venue.opensAt && startsAt.getTime() < venue.opensAt.getTime()) return "closed";
  return null;
}

function isBlocked(blocks: BlockLike[], roomId: string, startsAt: Date, endsAt: Date): boolean {
  return blocks.some((b) => (b.roomId === null || b.roomId === roomId) && overlaps(startsAt, endsAt, b.startsAt, b.endsAt));
}

function liveBookings(input: StateInput): BookingLike[] {
  return input.bookings.filter(
    (b) => b.id !== input.excludeBookingId && (b.status === "pending" || b.status === "confirmed"),
  );
}

function liveHolds(input: StateInput): HoldLike[] {
  const now = input.now.getTime();
  return input.holds.filter((h) => h.id !== input.excludeHoldId && h.expiresAt.getTime() > now);
}

/** Any live slot booking or hold in the room overlapping the interval. */
function slotBusy(bookings: BookingLike[], holds: HoldLike[], roomId: string, startsAt: Date, endsAt: Date): boolean {
  const hit = (x: { roomId: string; serviceKind: "session" | "slot"; startsAt: Date; endsAt: Date }) =>
    x.serviceKind === "slot" && x.roomId === roomId && overlaps(startsAt, endsAt, x.startsAt, x.endsAt);
  return bookings.some(hit) || holds.some(hit);
}

/** Opening hours of the local day containing `at`, as UTC instants; null when closed that day. */
export function openingWindow(openingHours: OpeningHours, day: string, tz = DEFAULT_TZ): { opensAt: Date; closesAt: Date } | null {
  const hours = openingHours[weekdayKey(startOfLocalDay(day, tz), tz)];
  if (!hours) return null;
  const opensAt = zonedDateTime(day, hours.open, tz);
  const closesAt = zonedDateTime(day, hours.close, tz);
  if (closesAt.getTime() <= opensAt.getTime()) return null;
  return { opensAt, closesAt };
}

// ---------- sessions ----------

export function computeSessionAvailability(input: SessionAvailabilityInput): SessionAvailability[] {
  const bookings = liveBookings(input);
  const holds = liveHolds(input);
  const sessions = input.sessions
    .filter((s) => s.serviceId === undefined || s.serviceId === input.service.id)
    .slice()
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  return sessions.map((session) => {
    const taken = bookings.filter((b) => b.sessionId === session.id).reduce((n, b) => n + b.places, 0);
    const held = holds.filter((h) => h.sessionId === session.id).reduce((n, h) => n + h.places, 0);
    const remaining = Math.max(0, session.capacity - taken - held);

    let reason: NotBookableReason | null = null;
    if (session.status === "cancelled") reason = "cancelled";
    else reason = timingReason(input.now, session.startsAt, input.service, input.ignoreTiming);
    reason ??= venueReason(input.venue, session.startsAt);
    if (!reason && isBlocked(input.blocks, session.roomId, session.startsAt, session.endsAt)) reason = "blocked";
    if (!reason && slotBusy(bookings, holds, session.roomId, session.startsAt, session.endsAt)) reason = "room_busy";
    if (!reason && remaining <= 0) reason = "full";

    return {
      sessionId: session.id,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      capacity: session.capacity,
      taken,
      held,
      remaining,
      bookable: reason === null,
      reason,
    };
  });
}

// ---------- slots ----------

export function isSlotBookable(input: SlotCheckInput): { bookable: boolean; reason: NotBookableReason | null } {
  const tz = input.tz ?? DEFAULT_TZ;
  const { startsAt, endsAt, service } = input;
  const no = (reason: NotBookableReason) => ({ bookable: false, reason });

  const timing = timingReason(input.now, startsAt, service, input.ignoreTiming);
  if (timing) return no(timing);
  const venue = venueReason(input.venue, startsAt);
  if (venue) return no(venue);

  const window = openingWindow(input.venue.openingHours, localDate(startsAt, tz), tz);
  if (!window) return no("closed");
  if (startsAt.getTime() < window.opensAt.getTime() || endsAt.getTime() > window.closesAt.getTime()) return no("closed");

  if (isBlocked(input.blocks, service.roomId, startsAt, endsAt)) return no("blocked");

  const bookings = liveBookings(input);
  const holds = liveHolds(input);
  if (slotBusy(bookings, holds, service.roomId, startsAt, endsAt)) return no("room_busy");

  // Sessions in the same room with at least one place taken or held. An empty session gives way.
  const sessionsById = new Map(input.sessions.map((s) => [s.id, s]));
  const occupiedSessionOverlaps = (x: { roomId: string; sessionId: string | null; serviceKind: "session" | "slot"; startsAt: Date; endsAt: Date; places: number }) => {
    if (x.serviceKind !== "session" || x.places <= 0) return false;
    const session = x.sessionId ? sessionsById.get(x.sessionId) : undefined;
    const roomId = session?.roomId ?? x.roomId;
    const s0 = session?.startsAt ?? x.startsAt;
    const s1 = session?.endsAt ?? x.endsAt;
    return roomId === service.roomId && overlaps(startsAt, endsAt, s0, s1);
  };
  if (bookings.some(occupiedSessionOverlaps) || holds.some(occupiedSessionOverlaps)) return no("room_busy");

  return { bookable: true, reason: null };
}

export function computeSlotStarts(input: SlotStartsInput): SlotStart[] {
  const tz = input.tz ?? DEFAULT_TZ;
  const window = openingWindow(input.venue.openingHours, input.day, tz);
  if (!window) return [];
  const length = input.service.lengthMinutes + Math.max(0, input.extraMinutes);
  const step = Math.max(5, input.service.slotIntervalMinutes);
  if (length <= 0) return [];

  const out: SlotStart[] = [];
  for (let startsAt = window.opensAt; ; startsAt = addMinutes(startsAt, step)) {
    const endsAt = addMinutes(startsAt, length);
    if (endsAt.getTime() > window.closesAt.getTime()) break;
    const { bookable, reason } = isSlotBookable({ ...input, startsAt, endsAt, tz });
    out.push({ startsAt, endsAt, bookable, reason });
  }
  return out;
}

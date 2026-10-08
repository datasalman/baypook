/**
 * Availability as staff see it: capacity and room rules apply, lead time and
 * cut-off do not (staff may book or move at short notice), and a booking being
 * moved does not count against itself. Each choice also says whether it is
 * inside the cut-off or needs more notice than online booking allows, so the
 * screen can say so.
 */
import type { DbOrTx } from "@/db";
import type * as s from "@/db/schema";
import {
  computeSessionAvailability,
  computeSlotStarts,
  timingReason,
  type NotBookableReason,
  type SessionAvailability,
  type SlotStart,
} from "@/core/availability";
import { endOfLocalDay, startOfLocalDay } from "@/core/time";
import { loadWindowState, toServiceRules, toVenueRules } from "@/server/availability";
import { ensureSessions, ensureVenueSessions } from "@/server/sessions";
import type { ServiceWithCatalogue } from "@/server/catalogue";

/** Why parents could not book this online right now (staff still can). */
export type Timing = "past" | "inside_cutoff" | "needs_notice" | null;

export type AdminSessionChoice = SessionAvailability & { timing: Timing };
export type AdminSlotChoice = SlotStart & { timing: Timing };

function timingOf(now: Date, startsAt: Date, service: s.Service): Timing {
  const r = timingReason(now, startsAt, service);
  if (r === "past") return "past";
  if (r === "cutoff") return "inside_cutoff";
  if (r === "lead_time") return "needs_notice";
  return null;
}

/** Sessions of one service on one local day, for staff. */
export async function adminSessionChoices(
  db: DbOrTx,
  input: { venue: s.Venue; service: ServiceWithCatalogue; date: string; tz: string; now?: Date; excludeBookingId?: string },
): Promise<AdminSessionChoice[]> {
  const { venue, service, date, tz } = input;
  if (service.kind !== "session") return [];
  const now = input.now ?? new Date();
  await ensureSessions(db, service, venue, date, date, tz);
  const from = startOfLocalDay(date, tz);
  const to = endOfLocalDay(date, tz);
  // Whole venue, not service.roomId: a session kept in its old room after a room change must still be offered.
  const state = await loadWindowState(db, { venueId: venue.id, from, to, now });
  const sessions = state.sessions.filter(
    (x) => x.serviceId === service.id && x.startsAt.getTime() >= from.getTime() && x.startsAt.getTime() < to.getTime(),
  );
  const list = computeSessionAvailability({
    now,
    service: toServiceRules(service),
    venue: toVenueRules(venue),
    ...state,
    sessions,
    excludeBookingId: input.excludeBookingId,
    ignoreTiming: true,
  });
  return list.map((a) => ({ ...a, timing: timingOf(now, a.startsAt, service) }));
}

/** Slot start times on one local day, for staff. `extraMinutes` = time add-ons (Food time). */
export async function adminSlotChoices(
  db: DbOrTx,
  input: {
    venue: s.Venue;
    service: ServiceWithCatalogue;
    date: string;
    tz: string;
    extraMinutes: number;
    now?: Date;
    excludeBookingId?: string;
  },
): Promise<AdminSlotChoice[]> {
  const { venue, service, date, tz } = input;
  if (service.kind !== "slot") return [];
  const now = input.now ?? new Date();
  // Sessions in the same room must exist as rows for their bookings to count as conflicts.
  await ensureVenueSessions(db, venue.id, date, date, tz);
  const state = await loadWindowState(db, {
    venueId: venue.id,
    roomId: service.roomId,
    from: startOfLocalDay(date, tz),
    to: endOfLocalDay(date, tz),
    now,
  });
  const list = computeSlotStarts({
    now,
    day: date,
    service: toServiceRules(service),
    venue: toVenueRules(venue),
    ...state,
    extraMinutes: Math.max(0, input.extraMinutes),
    tz,
    excludeBookingId: input.excludeBookingId,
    ignoreTiming: true,
  });
  return list.map((a) => ({ ...a, timing: timingOf(now, a.startsAt, service) }));
}

/** Short words for a time parents cannot book online but staff can. */
export const TIMING_SHORT: Record<Exclude<Timing, null>, string> = {
  past: "Started",
  inside_cutoff: "Inside the cut-off",
  needs_notice: "Needs more notice",
};

/** A sentence for the last step of a staff booking. */
export const TIMING_SENTENCE: Record<Exclude<Timing, null>, string> = {
  past: "This time has already started.",
  inside_cutoff: "This time is inside the cut-off: parents cannot book it online now, but staff can.",
  needs_notice: "Needs more notice: parents cannot book this time online yet, but staff can.",
};

/** Why staff cannot pick a time, in plain words. */
export const STAFF_REASON: Record<NotBookableReason, string> = {
  full: "Full",
  cutoff: "Inside the cut-off",
  lead_time: "Needs more notice",
  blocked: "Blocked time",
  room_busy: "Room in use",
  past: "Already started",
  cancelled: "Cancelled",
  closed: "Closed",
};

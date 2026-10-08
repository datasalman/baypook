import { describe, expect, it } from "vitest";
import {
  computeSessionAvailability,
  computeSlotStarts,
  isSlotBookable,
  openingWindow,
  timingReason,
  type BlockLike,
  type BookingLike,
  type HoldLike,
  type ServiceRules,
  type SessionLike,
  type VenueRules,
} from "@/core/availability";
import type { OpeningHours } from "@/db/schema";
import { addMinutes, localDate, zonedDateTime } from "@/core/time";

const DAY = "2026-10-20"; // Tuesday, BST
const at = (time: string, day = DAY) => zonedDateTime(day, time);
const FAR_BEFORE = new Date("2026-10-01T09:00:00Z");

const tenToSix = { open: "10:00", close: "18:00" };
const HOURS: OpeningHours = { mon: null, tue: tenToSix, wed: tenToSix, thu: tenToSix, fri: tenToSix, sat: tenToSix, sun: tenToSix };
const VENUE: VenueRules = { status: "open", opensAt: null, openingHours: HOURS };

const MAIN = "room-main";
const PARTY_ROOM = "room-party";

const WORKSHOP: ServiceRules = {
  id: "svc-workshop",
  kind: "session",
  roomId: MAIN,
  lengthMinutes: 60,
  slotIntervalMinutes: 30,
  leadTimeMinutes: 0,
  cutoffMinutes: 60,
};
const PARTY: ServiceRules = {
  id: "svc-party",
  kind: "slot",
  roomId: MAIN,
  lengthMinutes: 90,
  slotIntervalMinutes: 30,
  leadTimeMinutes: 48 * 60,
  cutoffMinutes: 0,
};

function session(time: string, opts: Partial<SessionLike> = {}, day = DAY): SessionLike {
  const startsAt = at(time, day);
  return {
    id: `s-${day}-${time}`,
    roomId: MAIN,
    startsAt,
    endsAt: addMinutes(startsAt, 60),
    capacity: 10,
    status: "scheduled",
    ...opts,
  };
}

/** Hourly workshop sessions 10:00..17:00 on DAY. */
const SESSIONS = ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"].map((t) => session(t));
const sessionAt = (time: string) => SESSIONS.find((s) => s.id === `s-${DAY}-${time}`)!;

let n = 0;
function sessionBooking(s: SessionLike, places: number, status: BookingLike["status"] = "confirmed"): BookingLike {
  return { id: `b${++n}`, roomId: s.roomId, sessionId: s.id, startsAt: s.startsAt, endsAt: s.endsAt, places, serviceKind: "session", status };
}
function sessionHold(s: SessionLike, places: number, expiresAt: Date): HoldLike {
  return { id: `h${++n}`, roomId: s.roomId, sessionId: s.id, startsAt: s.startsAt, endsAt: s.endsAt, places, serviceKind: "session", expiresAt };
}
function partyBooking(time: string, minutes = 90, roomId = MAIN, status: BookingLike["status"] = "confirmed"): BookingLike {
  const startsAt = at(time);
  return { id: `b${++n}`, roomId, sessionId: null, startsAt, endsAt: addMinutes(startsAt, minutes), places: 10, serviceKind: "slot", status };
}
function partyHold(time: string, expiresAt: Date, minutes = 90, roomId = MAIN): HoldLike {
  const startsAt = at(time);
  return { id: `h${++n}`, roomId, sessionId: null, startsAt, endsAt: addMinutes(startsAt, minutes), places: 10, serviceKind: "slot", expiresAt };
}

function slot(
  time: string,
  state: { bookings?: BookingLike[]; holds?: HoldLike[]; blocks?: BlockLike[]; sessions?: SessionLike[] } = {},
  opts: { now?: Date; minutes?: number; service?: ServiceRules; venue?: VenueRules; excludeBookingId?: string; excludeHoldId?: string; ignoreTiming?: boolean; day?: string } = {},
) {
  const startsAt = at(time, opts.day);
  return isSlotBookable({
    now: opts.now ?? FAR_BEFORE,
    startsAt,
    endsAt: addMinutes(startsAt, opts.minutes ?? 90),
    service: opts.service ?? PARTY,
    venue: opts.venue ?? VENUE,
    sessions: state.sessions ?? SESSIONS,
    bookings: state.bookings ?? [],
    holds: state.holds ?? [],
    blocks: state.blocks ?? [],
    excludeBookingId: opts.excludeBookingId,
    excludeHoldId: opts.excludeHoldId,
    ignoreTiming: opts.ignoreTiming,
  });
}

function sessions(
  state: { bookings?: BookingLike[]; holds?: HoldLike[]; blocks?: BlockLike[]; sessions?: SessionLike[] } = {},
  opts: { now?: Date; venue?: VenueRules; excludeBookingId?: string; excludeHoldId?: string; ignoreTiming?: boolean } = {},
) {
  const out = computeSessionAvailability({
    now: opts.now ?? FAR_BEFORE,
    service: WORKSHOP,
    venue: opts.venue ?? VENUE,
    sessions: state.sessions ?? SESSIONS,
    bookings: state.bookings ?? [],
    holds: state.holds ?? [],
    blocks: state.blocks ?? [],
    excludeBookingId: opts.excludeBookingId,
    excludeHoldId: opts.excludeHoldId,
    ignoreTiming: opts.ignoreTiming,
  });
  return (time: string) => out.find((a) => a.sessionId === `s-${DAY}-${time}`)!;
}

describe("empty session gives way to a party", () => {
  it("an empty workshop session does not block a party", () => {
    expect(slot("10:00")).toEqual({ bookable: true, reason: null });
  });

  it("one booked place blocks an overlapping party", () => {
    const bookings = [sessionBooking(sessionAt("11:00"), 1)];
    expect(slot("10:00", { bookings })).toEqual({ bookable: false, reason: "room_busy" });
    expect(slot("10:30", { bookings }).reason).toBe("room_busy");
    // 12:00 party starts as the 11:00 session ends: no overlap.
    expect(slot("12:00", { bookings }).bookable).toBe(true);
  });

  it("a pending booking blocks like a confirmed one", () => {
    const bookings = [sessionBooking(sessionAt("11:00"), 1, "pending")];
    expect(slot("10:30", { bookings }).reason).toBe("room_busy");
  });

  it("a held place blocks; an expired hold does not", () => {
    const now = FAR_BEFORE;
    const live = [sessionHold(sessionAt("11:00"), 1, addMinutes(now, 15))];
    expect(slot("10:30", { holds: live }, { now }).reason).toBe("room_busy");
    const expired = [sessionHold(sessionAt("11:00"), 1, now)];
    expect(slot("10:30", { holds: expired }, { now }).bookable).toBe(true);
  });

  it("a session booking with zero places does not block", () => {
    const bookings = [sessionBooking(sessionAt("11:00"), 0)];
    expect(slot("10:30", { bookings }).bookable).toBe(true);
  });

  it("uses the booking's own times when its session is not in the list", () => {
    const bookings = [sessionBooking(sessionAt("11:00"), 2)];
    expect(slot("10:30", { bookings, sessions: [] }).reason).toBe("room_busy");
  });

  it("uses the session's current times when the session was moved", () => {
    const moved = { ...sessionAt("11:00"), startsAt: at("15:00"), endsAt: at("16:00") };
    const bookings = [sessionBooking(sessionAt("11:00"), 2)]; // stale times 11:00-12:00
    expect(slot("10:30", { bookings, sessions: [moved] }).bookable).toBe(true);
    expect(slot("14:00", { bookings, sessions: [moved] }).reason).toBe("room_busy");
  });

  it("excludeBookingId and excludeHoldId skip one booking or hold", () => {
    const b = sessionBooking(sessionAt("11:00"), 3);
    const h = sessionHold(sessionAt("11:00"), 3, addMinutes(FAR_BEFORE, 15));
    expect(slot("10:30", { bookings: [b] }, { excludeBookingId: b.id }).bookable).toBe(true);
    expect(slot("10:30", { holds: [h] }, { excludeHoldId: h.id }).bookable).toBe(true);
  });
});

describe("a party blocks the sessions it overlaps", () => {
  it("90 minutes from 10:30 blocks 10:00 and 11:00, not 12:00", () => {
    const get = sessions({ bookings: [partyBooking("10:30")] });
    expect(get("10:00").reason).toBe("room_busy");
    expect(get("11:00").reason).toBe("room_busy");
    expect(get("12:00").bookable).toBe(true);
    expect(get("10:00").remaining).toBe(10); // places are free, the room is not
  });

  it("with Food time (120 minutes) it blocks one more session", () => {
    const get = sessions({ bookings: [partyBooking("10:30", 120)] });
    expect(get("10:00").reason).toBe("room_busy");
    expect(get("11:00").reason).toBe("room_busy");
    expect(get("12:00").reason).toBe("room_busy");
    expect(get("13:00").bookable).toBe(true);
  });

  it("a held party blocks; an expired party hold does not", () => {
    const now = FAR_BEFORE;
    expect(sessions({ holds: [partyHold("10:00", addMinutes(now, 1))] }, { now })("10:00").reason).toBe("room_busy");
    expect(sessions({ holds: [partyHold("10:00", now)] }, { now })("10:00").bookable).toBe(true);
  });

  it("a party blocks another overlapping party, not one that starts as it ends", () => {
    const bookings = [partyBooking("10:00")];
    expect(slot("11:00", { bookings }).reason).toBe("room_busy");
    expect(slot("11:30", { bookings }).bookable).toBe(true);
    const holds = [partyHold("13:00", addMinutes(FAR_BEFORE, 15))];
    expect(slot("12:00", { holds }).reason).toBe("room_busy");
    expect(slot("11:30", { holds }).bookable).toBe(true); // ends 13:00
  });
});

describe("overlap edges (16:00 end vs 16:00 start)", () => {
  it("a party ending at 16:00 does not block the 16:00 session; one starting at 16:00 does not block 15:00", () => {
    const endsAtFour = sessions({ bookings: [partyBooking("14:30")] });
    expect(endsAtFour("15:00").reason).toBe("room_busy");
    expect(endsAtFour("16:00").bookable).toBe(true);
    const startsAtFour = sessions({ bookings: [partyBooking("16:00")] });
    expect(startsAtFour("15:00").bookable).toBe(true);
    expect(startsAtFour("16:00").reason).toBe("room_busy");
  });

  it("a booked 15:00 session does not block a 16:00 party, and a booked 16:00 session does not block a 14:30 party", () => {
    expect(slot("16:00", { bookings: [sessionBooking(sessionAt("15:00"), 1)] }).bookable).toBe(true);
    expect(slot("14:30", { bookings: [sessionBooking(sessionAt("16:00"), 1)] }).bookable).toBe(true);
    expect(slot("14:31", { bookings: [sessionBooking(sessionAt("16:00"), 1)] }).reason).toBe("room_busy");
  });

  it("blocks ending at a start or starting at an end do not block", () => {
    const blocks: BlockLike[] = [{ roomId: null, startsAt: at("09:00"), endsAt: at("10:00") }];
    expect(sessions({ blocks })("10:00").bookable).toBe(true);
    expect(slot("10:00", { blocks }).bookable).toBe(true);
  });
});

describe("rooms do not cross-block", () => {
  const LAKESIDE_PARTY: ServiceRules = { ...PARTY, roomId: PARTY_ROOM };
  it("a party in the party room does not block the workshop floor", () => {
    const get = sessions({ bookings: [partyBooking("10:00", 120, PARTY_ROOM)] });
    expect(get("10:00").bookable).toBe(true);
    expect(get("11:00").bookable).toBe(true);
  });
  it("a booked workshop does not block a party in the party room", () => {
    const bookings = [sessionBooking(sessionAt("10:00"), 5)];
    expect(slot("10:00", { bookings }, { service: LAKESIDE_PARTY }).bookable).toBe(true);
  });
  it("a room block only blocks its room; a venue block blocks every room", () => {
    const roomBlock: BlockLike[] = [{ roomId: PARTY_ROOM, startsAt: at("10:00"), endsAt: at("18:00") }];
    expect(sessions({ blocks: roomBlock })("10:00").bookable).toBe(true);
    expect(slot("10:00", { blocks: roomBlock }, { service: LAKESIDE_PARTY }).reason).toBe("blocked");
    const venueBlock: BlockLike[] = [{ roomId: null, startsAt: at("12:30"), endsAt: at("13:30") }];
    expect(sessions({ blocks: venueBlock })("12:00").reason).toBe("blocked");
    expect(sessions({ blocks: venueBlock })("13:00").reason).toBe("blocked");
    expect(sessions({ blocks: venueBlock })("14:00").bookable).toBe(true);
    expect(slot("11:00", { blocks: venueBlock }, { service: LAKESIDE_PARTY }).bookable).toBe(true); // ends 12:30
    expect(slot("11:30", { blocks: venueBlock }, { service: LAKESIDE_PARTY }).reason).toBe("blocked");
  });
});

describe("lead time and cut-off", () => {
  it("a party needs 48 hours' notice: bookable at exactly 48 hours", () => {
    const start = at("10:00");
    expect(slot("10:00", {}, { now: addMinutes(start, -48 * 60) }).bookable).toBe(true);
    expect(slot("10:00", {}, { now: new Date(start.getTime() - 48 * 3_600_000 + 1) }).reason).toBe("lead_time");
    expect(slot("10:00", {}, { now: start }).reason).toBe("past");
  });

  it("a workshop can be booked until 60 minutes before: bookable at exactly 60", () => {
    const start = at("12:00");
    expect(sessions({}, { now: addMinutes(start, -60) })("12:00").bookable).toBe(true);
    expect(sessions({}, { now: new Date(start.getTime() - 3_600_000 + 1) })("12:00").reason).toBe("cutoff");
    expect(sessions({}, { now: start })("12:00").reason).toBe("past");
    expect(sessions({}, { now: addMinutes(start, 30) })("12:00").reason).toBe("past");
  });

  it("ignoreTiming lets an admin book inside the cut-off or after the start", () => {
    const start = at("12:00");
    expect(sessions({}, { now: addMinutes(start, 10), ignoreTiming: true })("12:00").bookable).toBe(true);
    expect(slot("10:00", {}, { now: at("09:00"), ignoreTiming: true }).bookable).toBe(true);
  });

  it("timingReason prefers lead time over cut-off when both apply", () => {
    const now = new Date("2026-10-20T08:00:00Z");
    expect(timingReason(now, addMinutes(now, 30), { leadTimeMinutes: 120, cutoffMinutes: 60 })).toBe("lead_time");
    expect(timingReason(now, addMinutes(now, 30), { leadTimeMinutes: 0, cutoffMinutes: 60 })).toBe("cutoff");
    expect(timingReason(now, addMinutes(now, 30), { leadTimeMinutes: 0, cutoffMinutes: 0 })).toBeNull();
  });
});

describe("capacity", () => {
  it("counts pending, confirmed and live held places", () => {
    const s = sessionAt("14:00");
    const now = FAR_BEFORE;
    const bookings = [sessionBooking(s, 4), sessionBooking(s, 3, "pending")];
    const holds = [sessionHold(s, 2, addMinutes(now, 10)), sessionHold(s, 5, now /* expired */)];
    const a = sessions({ bookings, holds }, { now })("14:00");
    expect(a).toMatchObject({ capacity: 10, taken: 7, held: 2, remaining: 1, bookable: true, reason: null });

    const lastHold = sessionHold(s, 1, addMinutes(now, 10));
    const full = sessions({ bookings, holds: [...holds, lastHold] }, { now })("14:00");
    expect(full).toMatchObject({ remaining: 0, bookable: false, reason: "full" });

    const reChecked = sessions({ bookings, holds: [...holds, lastHold] }, { now, excludeHoldId: lastHold.id })("14:00");
    expect(reChecked.remaining).toBe(1);
    const moved = sessions({ bookings, holds }, { now, excludeBookingId: bookings[0].id })("14:00");
    expect(moved.remaining).toBe(5);
  });

  it("never reports negative remaining when over-booked by an admin", () => {
    const s = sessionAt("15:00");
    expect(sessions({ bookings: [sessionBooking(s, 12)] })("15:00")).toMatchObject({ remaining: 0, reason: "full" });
  });

  it("ignores bookings in other statuses defensively", () => {
    const s = sessionAt("15:00");
    const odd = { ...sessionBooking(s, 5), status: "cancelled" } as unknown as BookingLike;
    expect(sessions({ bookings: [odd] })("15:00").remaining).toBe(10);
  });
});

describe("session status, venue status and filtering", () => {
  it("reports cancelled sessions", () => {
    const list = [session("10:00", { status: "cancelled" })];
    expect(sessions({ sessions: list })("10:00")).toMatchObject({ bookable: false, reason: "cancelled" });
  });

  it("reports a closed venue and sessions before the opening date", () => {
    expect(sessions({}, { venue: { ...VENUE, status: "closed" } })("10:00").reason).toBe("closed");
    const opening: VenueRules = { ...VENUE, status: "opening", opensAt: at("12:00") };
    const get = sessions({}, { venue: opening });
    expect(get("11:00").reason).toBe("closed");
    expect(get("12:00").bookable).toBe(true);
  });

  it("only reports sessions of the service when sessions carry a serviceId, sorted by start", () => {
    const list = [
      session("12:00", { serviceId: WORKSHOP.id }),
      session("10:00", { serviceId: "another" }),
      session("11:00"),
    ];
    const out = computeSessionAvailability({
      now: FAR_BEFORE,
      service: WORKSHOP,
      venue: VENUE,
      sessions: list,
      bookings: [],
      holds: [],
      blocks: [],
    });
    expect(out.map((a) => a.sessionId)).toEqual([`s-${DAY}-11:00`, `s-${DAY}-12:00`]);
  });
});

describe("slot starts", () => {
  const starts = (day: string, extraMinutes = 0, venue = VENUE, state: { bookings?: BookingLike[] } = {}) =>
    computeSlotStarts({
      now: FAR_BEFORE,
      day,
      service: PARTY,
      venue,
      sessions: SESSIONS,
      bookings: state.bookings ?? [],
      holds: [],
      blocks: [],
      extraMinutes,
    });

  it("offers every 30 minutes from opening to the last start that fits", () => {
    const out = starts(DAY);
    expect(out).toHaveLength(14); // 10:00 .. 16:30 for 90 minutes before 18:00
    expect(out[0].startsAt.toISOString()).toBe("2026-10-20T09:00:00.000Z");
    expect(out.at(-1)!.startsAt.toISOString()).toBe(at("16:30").toISOString());
    expect(out.at(-1)!.endsAt.toISOString()).toBe(at("18:00").toISOString());
    expect(out.every((x) => x.bookable)).toBe(true);
  });

  it("checks the full length with Food time", () => {
    const out = starts(DAY, 30);
    expect(out).toHaveLength(13); // last start 16:00
    expect(out.at(-1)!.endsAt.toISOString()).toBe(at("18:00").toISOString());
  });

  it("returns nothing on a closed day and flags a closed venue", () => {
    expect(starts("2026-10-19")).toEqual([]); // Monday
    const closed = starts(DAY, 0, { ...VENUE, status: "closed" });
    expect(closed.every((x) => x.reason === "closed")).toBe(true);
  });

  it("flags starts before the venue opening date", () => {
    const out = starts(DAY, 0, { ...VENUE, status: "opening", opensAt: at("12:00") });
    expect(out.find((x) => x.startsAt.getTime() === at("11:30").getTime())!.reason).toBe("closed");
    expect(out.find((x) => x.startsAt.getTime() === at("12:00").getTime())!.bookable).toBe(true);
  });

  it("marks starts that clash with a booked session as room busy", () => {
    const out = starts(DAY, 0, VENUE, { bookings: [sessionBooking(sessionAt("13:00"), 2)] });
    const busy = out.filter((x) => !x.bookable).map((x) => x.startsAt.getTime());
    // 12:00 .. 13:30 overlap 13:00-14:00; 11:30 ends at 13:00 and 14:00 starts as it ends
    expect(busy).toEqual(["12:00", "12:30", "13:00", "13:30"].map((t) => at(t).getTime()));
  });

  it("isSlotBookable rejects a slot outside opening hours or on a closed day", () => {
    expect(slot("17:00").reason).toBe("closed"); // ends 18:30
    expect(slot("09:30").reason).toBe("closed");
    expect(slot("12:00", {}, { day: "2026-10-19" }).reason).toBe("closed");
  });
});

describe("BST to GMT weekend (clocks go back Sun 25 Oct 2026)", () => {
  it("a 10:00 start is 09:00Z on Saturday and 10:00Z on Sunday", () => {
    const sat = computeSlotStarts({ now: FAR_BEFORE, day: "2026-10-24", service: PARTY, venue: VENUE, sessions: [], bookings: [], holds: [], blocks: [], extraMinutes: 0 });
    const sun = computeSlotStarts({ now: FAR_BEFORE, day: "2026-10-25", service: PARTY, venue: VENUE, sessions: [], bookings: [], holds: [], blocks: [], extraMinutes: 0 });
    expect(sat[0].startsAt.toISOString()).toBe("2026-10-24T09:00:00.000Z");
    expect(sun[0].startsAt.toISOString()).toBe("2026-10-25T10:00:00.000Z");
    expect(sat).toHaveLength(14);
    expect(sun).toHaveLength(14);
    expect(sun.at(-1)!.endsAt.toISOString()).toBe("2026-10-25T18:00:00.000Z");
  });

  it("opening windows follow the local day", () => {
    expect(openingWindow(HOURS, "2026-10-24")).toEqual({
      opensAt: new Date("2026-10-24T09:00:00Z"),
      closesAt: new Date("2026-10-24T17:00:00Z"),
    });
    expect(openingWindow(HOURS, "2026-10-25")).toEqual({
      opensAt: new Date("2026-10-25T10:00:00Z"),
      closesAt: new Date("2026-10-25T18:00:00Z"),
    });
    expect(openingWindow(HOURS, "2026-10-26")).toBeNull(); // Monday
    expect(openingWindow({ ...HOURS, tue: { open: "18:00", close: "10:00" } }, DAY)).toBeNull();
  });

  it("day boundaries hold across the change: night-time hours on Sunday stay on Sunday", () => {
    // Not a business case; proves the arithmetic. 00:00 BST (23:00Z Sat) to 03:00 GMT is four real hours.
    const night: OpeningHours = { ...HOURS, sun: { open: "00:00", close: "03:00" } };
    const hourly: ServiceRules = { ...PARTY, lengthMinutes: 60, slotIntervalMinutes: 60, leadTimeMinutes: 0 };
    const saturdayLate: BookingLike = {
      id: "late",
      roomId: MAIN,
      sessionId: null,
      startsAt: new Date("2026-10-24T22:00:00Z"), // 23:00 BST Saturday
      endsAt: new Date("2026-10-24T23:00:00Z"), // 00:00 BST Sunday
      places: 10,
      serviceKind: "slot",
      status: "confirmed",
    };
    const out = computeSlotStarts({
      now: FAR_BEFORE,
      day: "2026-10-25",
      service: hourly,
      venue: { ...VENUE, openingHours: night },
      sessions: [],
      bookings: [saturdayLate],
      holds: [],
      blocks: [],
      extraMinutes: 0,
    });
    expect(out.map((x) => x.startsAt.toISOString())).toEqual([
      "2026-10-24T23:00:00.000Z",
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T01:00:00.000Z",
      "2026-10-25T02:00:00.000Z",
    ]);
    expect(out.every((x) => localDate(x.startsAt) === "2026-10-25")).toBe(true);
    // Saturday's booking ends exactly as Sunday opens: no overlap.
    expect(out.every((x) => x.bookable)).toBe(true);
  });

  it("a session booked on Saturday does not block Sunday at the same wall-clock time", () => {
    const satSession = session("10:00", {}, "2026-10-24");
    const sunParty = isSlotBookable({
      now: FAR_BEFORE,
      startsAt: zonedDateTime("2026-10-25", "10:00"),
      endsAt: zonedDateTime("2026-10-25", "11:30"),
      service: PARTY,
      venue: VENUE,
      sessions: [satSession],
      bookings: [sessionBooking(satSession, 3)],
      holds: [],
      blocks: [],
    });
    expect(sunParty.bookable).toBe(true);
  });
});

/**
 * Regression tests for the third-round review findings (X3). Each `describe`
 * names its finding number from the brief.
 */
process.env.BAYPOOK_MODE = "demo";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { localDate, zonedDateTime } from "@/core/time";
import type { CurrentUser } from "@/server/auth";
import { getVenueBySlug } from "@/server/org";
import { getServiceBySlug, type ServiceWithCatalogue } from "@/server/catalogue";
import { getSessionAvailability } from "@/server/availability";
import { createManualBooking } from "@/server/bookings";
import { searchCustomers } from "@/server/customers";
import {
  addExtraSession,
  addTimetableException,
  addTimetableRules,
  createService,
  deleteTimetableException,
  deleteTimetableRule,
  fillTimetableFromOpeningHours,
  setSessionCapacity,
  updateTimetableRuleCapacity,
} from "@/server/catalogue-admin";
import { updateVenue } from "@/server/settings";
import { refundsInRange, takingsByDay } from "@/server/reports";
import { setUserActive, updateUser, UsersAdminError } from "@/server/users-admin";
import { importWix, parseCsv, readWixCsv } from "../../../scripts/import-wix";

const NOW = new Date("2026-10-10T09:00:00Z");
const DAY = "2026-10-24"; // a Saturday
const TZ = "Europe/London";
const WEEKDAY = 6;

type Ctx = { db: Db; venue: s.Venue; workshops: ServiceWithCatalogue; owner: CurrentUser };
let c: Ctx;

beforeEach(async () => {
  // Anything not given `now` works out "today" from the clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const db = await createTestDb({ seed: true });
  const venue = (await getVenueBySlug(db, "south-woodford"))!;
  const workshops = (await getServiceBySlug(db, venue.id, "classic-workshops"))!;
  const [ownerRow] = await db.select().from(s.users).where(eq(s.users.isOwner, true));
  c = { db, venue, workshops, owner: { id: ownerRow.id, email: ownerRow.email, name: ownerRow.name, isOwner: true, venues: [] } };
  await getSessionAvailability(db, { venue, service: workshops, from: DAY, to: DAY, now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

const at = (time: string, day = DAY) => zonedDateTime(day, time, TZ);
const slime = () => c.workshops.options.find((o) => o.name === "Slime Workshop")!.id;

async function sessionAt(time: string, day = DAY): Promise<s.Session | undefined> {
  const [row] = await c.db
    .select()
    .from(s.sessions)
    .where(and(eq(s.sessions.serviceId, c.workshops.id), eq(s.sessions.startsAt, at(time, day))));
  return row;
}

async function manual(time: string, qty: number, email = "") {
  const session = await sessionAt(time);
  return createManualBooking(c.db, {
    user: c.owner,
    venue: c.venue,
    service: c.workshops,
    sessionId: session!.id,
    lines: [{ optionId: slime(), qty }],
    addOns: [],
    customer: { firstName: "Walk", lastName: "In", email, phone: null },
    payment: { method: "cash" },
    sendEmail: false,
    now: NOW,
  });
}

async function availabilityAt(time: string) {
  const avail = await getSessionAvailability(c.db, { venue: c.venue, service: c.workshops, from: DAY, to: DAY, now: NOW });
  return avail.find((a) => a.startsAt.getTime() === at(time).getTime());
}

async function ruleAt(time: string): Promise<s.TimetableRule> {
  const [rule] = await c.db
    .select()
    .from(s.timetableRules)
    .where(and(eq(s.timetableRules.serviceId, c.workshops.id), eq(s.timetableRules.startTime, time), eq(s.timetableRules.weekday, WEEKDAY)));
  return rule;
}

describe("1: a session the rules stop producing stops selling but keeps its bookings", () => {
  it("cancel one time: kept scheduled, pinned and full; restored when the change is removed", async () => {
    await manual("14:00", 2);
    const r = await addTimetableException(c.db, c.owner, c.workshops.id, { date: DAY, kind: "cancel_time", startTime: "14:00" }, { now: NOW });
    expect(r.keptWithBookings).toBe(1);
    expect(r.message).toMatch(/1 session has bookings, so it was kept and closed to new bookings/);
    expect(await sessionAt("14:00")).toMatchObject({ status: "scheduled", pinned: true, source: "manual", capacity: 2 });
    expect(await availabilityAt("14:00")).toMatchObject({ remaining: 0, bookable: false, reason: "full" });

    await deleteTimetableException(c.db, c.owner, r.exception.id);
    expect(await sessionAt("14:00")).toMatchObject({ status: "scheduled", pinned: false, source: "rule", capacity: 10 });
    expect(await availabilityAt("14:00")).toMatchObject({ remaining: 8, bookable: true });
  });

  it("cancel the whole day and delete a rule close the sessions with bookings", async () => {
    await manual("11:00", 3);
    const day = await addTimetableException(c.db, c.owner, c.workshops.id, { date: DAY, kind: "cancel_day" }, { now: NOW });
    expect(day.keptWithBookings).toBe(1);
    expect(await sessionAt("11:00")).toMatchObject({ capacity: 3, pinned: true, source: "manual" });
    expect(await sessionAt("12:00")).toBeUndefined();
    await deleteTimetableException(c.db, c.owner, day.exception.id);

    const removed = await deleteTimetableRule(c.db, c.owner, (await ruleAt("11:00")).id, { now: NOW });
    expect(removed.keptWithBookings).toBeGreaterThanOrEqual(1);
    expect(removed.message).toMatch(/kept and closed to new bookings/);
    expect(await availabilityAt("11:00")).toMatchObject({ remaining: 0, reason: "full" });
  });

  it("10: closing the venue keeps booked sessions full, reports the bookings, and reopening restores them", async () => {
    await manual("15:00", 1);
    const closed = await updateVenue(c.db, c.owner, c.venue.id, { status: "closed" }, { now: NOW });
    expect(closed.futureBookings).toBe(1);
    expect(closed.message).toMatch(/1 booking is still coming up/);
    expect(await sessionAt("15:00")).toMatchObject({ status: "scheduled", pinned: true, source: "manual", capacity: 1 });
    expect(await sessionAt("16:00")).toBeUndefined();

    const open = await updateVenue(c.db, c.owner, c.venue.id, { status: "open" }, { now: NOW });
    expect(open.futureBookings).toBe(0);
    expect(await sessionAt("15:00")).toMatchObject({ status: "scheduled", pinned: false, source: "rule", capacity: 10 });
    expect(await sessionAt("16:00")).toMatchObject({ status: "scheduled", capacity: 10 });
  });
});

describe("2: one-off changes apply to pinned sessions too", () => {
  it("a cancel exception removes a pinned session with no bookings and closes one with bookings", async () => {
    await setSessionCapacity(c.db, c.owner, (await sessionAt("10:00"))!.id, 12);
    await setSessionCapacity(c.db, c.owner, (await sessionAt("13:00"))!.id, 12);
    await manual("13:00", 4);

    await addTimetableException(c.db, c.owner, c.workshops.id, { date: DAY, kind: "cancel_time", startTime: "10:00" }, { now: NOW });
    expect(await sessionAt("10:00")).toBeUndefined();

    const r = await addTimetableException(c.db, c.owner, c.workshops.id, { date: DAY, kind: "cancel_time", startTime: "13:00" }, { now: NOW });
    expect(r.keptWithBookings).toBe(1);
    expect(await sessionAt("13:00")).toMatchObject({ status: "scheduled", pinned: true, source: "manual", capacity: 4 });
  });

  it("a capacity exception changes a pinned session, never below the places booked", async () => {
    await setSessionCapacity(c.db, c.owner, (await sessionAt("10:00"))!.id, 12);
    const quiet = await addTimetableException(c.db, c.owner, c.workshops.id, { date: DAY, kind: "capacity", startTime: "10:00", capacity: 6 }, { now: NOW });
    expect(quiet.heldAbove).toBe(0);
    expect(await sessionAt("10:00")).toMatchObject({ capacity: 6, pinned: true });

    await setSessionCapacity(c.db, c.owner, (await sessionAt("11:00"))!.id, 12);
    await manual("11:00", 5);
    const busy = await addTimetableException(c.db, c.owner, c.workshops.id, { date: DAY, kind: "capacity", startTime: "11:00", capacity: 2 }, { now: NOW });
    expect(busy.heldAbove).toBe(1);
    expect(busy.message).toMatch(/1 session already has more places booked/);
    expect(await sessionAt("11:00")).toMatchObject({ capacity: 5, pinned: true });
  });

  it("deleting a rule removes its pinned sessions with no bookings", async () => {
    await setSessionCapacity(c.db, c.owner, (await sessionAt("16:00"))!.id, 3);
    await deleteTimetableRule(c.db, c.owner, (await ruleAt("16:00")).id, { now: NOW });
    expect(await sessionAt("16:00")).toBeUndefined();
  });
});

describe("3: capacity changes never drop below the places booked", () => {
  it("a lower rule capacity keeps booked sessions at their places and says so", async () => {
    await manual("14:00", 6);
    const r = await updateTimetableRuleCapacity(c.db, c.owner, (await ruleAt("14:00")).id, 4, { now: NOW });
    expect(r.capacity).toBe(4);
    expect(r.heldAbove).toBe(1);
    expect(r.message).toMatch(/14:00 now has 4 places\. 1 session already has more places booked than that/);
    expect(await sessionAt("14:00")).toMatchObject({ capacity: 6, pinned: false });
    expect(await sessionAt("14:00", "2026-10-31")).toMatchObject({ capacity: 4 });
    expect(await availabilityAt("14:00")).toMatchObject({ remaining: 0 });

    // Places freed later: the rule's number applies again.
    const again = await updateTimetableRuleCapacity(c.db, c.owner, (await ruleAt("14:00")).id, 8, { now: NOW });
    expect(again.heldAbove).toBe(0);
    expect(await sessionAt("14:00")).toMatchObject({ capacity: 8 });
  });

  it("a capacity exception below the places booked keeps them and warns", async () => {
    await manual("15:00", 5);
    const r = await addTimetableException(c.db, c.owner, c.workshops.id, { date: DAY, kind: "capacity", startTime: "15:00", capacity: 2 }, { now: NOW });
    expect(r.heldAbove).toBe(1);
    expect(r.message).toMatch(/more places booked/);
    expect(await sessionAt("15:00")).toMatchObject({ capacity: 5 });
  });
});

describe("4: refunds of imported Wix payments are not BayPook money out", () => {
  it("leaves them out of takings and marks them in the refunds list", async () => {
    const b = await manual("12:00", 1);
    const [p] = await c.db
      .insert(s.payments)
      .values({ bookingId: b.id, venueId: c.venue.id, provider: "import", amountPence: 1700, status: "succeeded", method: "imported", createdAt: NOW })
      .returning();
    await c.db.insert(s.refunds).values({ paymentId: p.id, bookingId: b.id, amountPence: 1700, reason: "Wix", status: "succeeded", createdAt: NOW });
    const range = { venueIds: [c.venue.id], from: localDate(NOW, TZ), to: localDate(NOW, TZ), tz: TZ };
    const takings = await takingsByDay(c.db, range);
    expect(takings.totals.refundsPence).toBe(0);
    const refunds = await refundsInRange(c.db, range);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].wixPayment).toBe(true);
  });
});

describe("5: customer search is scoped by venue in SQL", () => {
  it("finds only parents who booked at the given venues, before the limit", async () => {
    await manual("10:00", 1, "scoped.parent@example.com");
    const [org] = await c.db.select().from(s.organisations);
    // A more recently updated customer with the same name who never booked here.
    await c.db.insert(s.customers).values({ organisationId: org.id, firstName: "Walk", lastName: "In", email: "other.parent@example.com", updatedAt: new Date(NOW.getTime() + 60_000) });
    const lk = (await getVenueBySlug(c.db, "lakeside"))!;

    const scoped = await searchCustomers(c.db, { q: "Walk", limit: 1, venueIds: [c.venue.id] });
    expect(scoped.map((x) => x.email)).toEqual(["scoped.parent@example.com"]);
    expect(await searchCustomers(c.db, { q: "Walk", venueIds: [lk.id] })).toEqual([]);
    expect(await searchCustomers(c.db, { q: "Walk", venueIds: [] })).toEqual([]);
    expect((await searchCustomers(c.db, { q: "Walk", venueIds: null })).length).toBe(2);
  });
});

describe("6 and 7: the Wix dry run", () => {
  const header = "reference,venue,service,start,first_name,last_name,email,phone,places,paid_total";

  it("finds clashes within the same file, as a real run would", async () => {
    const csv = [
      header,
      "WX-1,south-woodford,Slime Party,2026-11-08 11:00,Ben,Okafor,ben@example.com,,10,250",
      "WX-2,south-woodford,Slime Party,2026-11-08 12:00,Dan,Lee,dan@example.com,,10,250",
      "WX-3,south-woodford,Classic Workshops,2026-11-07 14:00,Amy,Ray,amy@example.com,,8,136",
      "WX-4,south-woodford,Classic Workshops,2026-11-07 14:00,Eve,Ray,eve@example.com,,3,51",
    ].join("\n");
    const dry = await importWix(c.db, csv, { user: c.owner, dryRun: true, now: NOW });
    expect(dry.map((o) => [o.reference, o.result])).toEqual([
      ["WX-1", "would create"],
      ["WX-2", "failed"],
      ["WX-3", "would create"],
      ["WX-4", "failed"],
    ]);
    expect(dry[3].message).toMatch(/Only 2 places left/);

    const real = await importWix(c.db, csv, { user: c.owner, now: NOW });
    expect(real.map((o) => o.result)).toEqual(["created", "failed", "created", "failed"]);
  });

  it("writes nothing: no bookings, customers or sessions", async () => {
    const count = async () => ({
      bookings: (await c.db.select().from(s.bookings)).length,
      customers: (await c.db.select().from(s.customers)).length,
      sessions: (await c.db.select().from(s.sessions)).length,
      exceptions: (await c.db.select().from(s.timetableExceptions)).length,
    });
    const before = await count();
    const csv = [header, "WX-9,south-woodford,Classic Workshops,2026-11-21 14:00,Amy,Ray,amy@example.com,,2,34"].join("\n");
    const dry = await importWix(c.db, csv, { user: c.owner, dryRun: true, now: NOW });
    expect(dry.map((o) => o.result)).toEqual(["would create"]);
    expect(await count()).toEqual(before);
  });
});

describe("8: CSV rows with only blank cells", () => {
  it("are dropped by the parser", () => {
    expect(parseCsv("a,b\n,\n1,2\n , \r\n,,\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    const read = readWixCsv("reference,venue,service,start,first_name\n,,,,\nWX-1,sw,Classic,2026-11-07 14:00,Amy\n");
    expect(read.problems).toEqual([]);
    expect(read.rows.map((r) => r.reference)).toEqual(["WX-1"]);
  });
});

describe("9: fill from opening hours", () => {
  it("does not count a rule that has ended as covering a time", async () => {
    const [room] = await c.db.select().from(s.rooms).where(eq(s.rooms.venueId, c.venue.id));
    const svc = await createService(c.db, c.owner, { venueId: c.venue.id, kind: "session", name: "Mini Workshop", roomId: room.id, lengthMinutes: 60 });
    await addTimetableRules(c.db, c.owner, svc.id, { weekdays: [2], startTime: "10:00", capacity: 8, validFrom: "2026-01-01", validTo: "2026-02-01" });
    await addTimetableRules(c.db, c.owner, svc.id, { weekdays: [2], startTime: "11:00", capacity: 8, validTo: "2026-12-31" });
    const { added } = await fillTimetableFromOpeningHours(c.db, c.owner, svc.id, { now: NOW });
    // 8 starts a day x 6 open days, minus the still-valid Tuesday 11:00; the ended Tuesday 10:00 is added again.
    expect(added).toBe(47);
    const tue10 = await c.db
      .select()
      .from(s.timetableRules)
      .where(and(eq(s.timetableRules.serviceId, svc.id), eq(s.timetableRules.weekday, 2), eq(s.timetableRules.startTime, "10:00")));
    expect(tue10).toHaveLength(2);
  });
});

describe("12: an extra session is refused before anything is written", () => {
  it("at a closed venue or before it opens", async () => {
    const exceptions = async () => (await c.db.select().from(s.timetableExceptions)).length;
    const before = await exceptions();
    await c.db.update(s.venues).set({ status: "closed" }).where(eq(s.venues.id, c.venue.id));
    await expect(addExtraSession(c.db, c.owner, c.workshops.id, { date: DAY, startTime: "09:00", capacity: 5 }, { now: NOW })).rejects.toThrow(
      /venue is not closed/,
    );
    const lk = (await getVenueBySlug(c.db, "lakeside"))!;
    const lkWorkshops = (await getServiceBySlug(c.db, lk.id, "classic-workshops"))!;
    await expect(addExtraSession(c.db, c.owner, lkWorkshops.id, { date: "2026-10-16", startTime: "09:00", capacity: 5 }, { now: NOW })).rejects.toThrow(
      /before the venue opens/,
    );
    expect(await exceptions()).toBe(before);
  });

  it("opens again a session kept only for its bookings", async () => {
    await manual("14:00", 2);
    await addTimetableException(c.db, c.owner, c.workshops.id, { date: DAY, kind: "cancel_time", startTime: "14:00" }, { now: NOW });
    await expect(setSessionCapacity(c.db, c.owner, (await sessionAt("14:00"))!.id, 9)).rejects.toThrow(/closed to new bookings/);
    const reopened = await addExtraSession(c.db, c.owner, c.workshops.id, { date: DAY, startTime: "14:00", capacity: 6 }, { now: NOW });
    expect(reopened).toMatchObject({ status: "scheduled", pinned: false, capacity: 6 });
    expect(await availabilityAt("14:00")).toMatchObject({ remaining: 4, bookable: true });
  });
});

describe("13: last-owner protection is race-safe", () => {
  /** A db whose next write transaction starts just after another request turned `ownerId` off. */
  function racing(ownerId: string, change: Partial<typeof s.users.$inferInsert>): Db {
    const db = Object.create(c.db) as Db;
    const transaction: Db["transaction"] = async (fn, config) => {
      await c.db.update(s.users).set(change).where(eq(s.users.id, ownerId));
      return c.db.transaction(fn, config);
    };
    Object.assign(db, { transaction });
    return db;
  }

  async function secondOwner(): Promise<string> {
    const [u] = await c.db.insert(s.users).values({ email: "second.owner@example.com", name: "Second owner", isOwner: true, active: true }).returning();
    return u.id;
  }

  async function user(id: string): Promise<s.User> {
    const [u] = await c.db.select().from(s.users).where(eq(s.users.id, id));
    return u;
  }

  it("refuses to deactivate an owner when the other owner was turned off meanwhile, and rolls back", async () => {
    const other = await secondOwner();
    const err = await setUserActive(racing(c.owner.id, { active: false }), { by: c.owner, userId: other, active: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsersAdminError);
    expect((err as UsersAdminError).code).toBe("LAST_OWNER");
    expect((await user(other)).active).toBe(true);
  });

  it("refuses to demote an owner when the other owner was demoted meanwhile", async () => {
    const other = await secondOwner();
    const err = await updateUser(racing(c.owner.id, { isOwner: false }), {
      by: c.owner,
      userId: other,
      name: "Second owner",
      isOwner: false,
      venues: [{ venueId: c.venue.id, role: "manager" }],
    }).catch((e: unknown) => e);
    expect((err as UsersAdminError).code).toBe("LAST_OWNER");
    expect((await user(other)).isOwner).toBe(true);
  });
});

describe("14: venue status and opening date are checked together with what is saved", () => {
  it("needs an opening date for an opening venue", async () => {
    expect(c.venue.opensAt).toBeNull();
    await expect(updateVenue(c.db, c.owner, c.venue.id, { status: "opening" }, { now: NOW })).rejects.toThrow(/opening date/);
    const lk = (await getVenueBySlug(c.db, "lakeside"))!;
    expect(lk.status).toBe("opening");
    await expect(updateVenue(c.db, c.owner, lk.id, { opensAt: null }, { now: NOW })).rejects.toThrow(/opening date/);
    const ok = await updateVenue(c.db, c.owner, c.venue.id, { status: "opening", opensAt: at("10:00", "2026-11-01") }, { now: NOW });
    expect(ok.status).toBe("opening");
  });
});

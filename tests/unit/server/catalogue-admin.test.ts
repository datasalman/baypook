process.env.BAYPOOK_MODE = "demo";

import { beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { addDays, localDate, zonedDateTime } from "@/core/time";
import type { CurrentUser } from "@/server/auth";
import { listServicesForVenue } from "@/server/catalogue";
import {
  AdminError,
  addExtraSession,
  addTimetableException,
  addTimetableRules,
  cancelSession,
  closeWholeDay,
  createAddOn,
  createBlock,
  createOption,
  createService,
  deleteTimetableRule,
  fillTimetableFromOpeningHours,
  hourlyStarts,
  listSessionsForDay,
  listUpcomingBlocks,
  moveService,
  poundsToPence,
  setOptionArchived,
  setSessionCapacity,
  updateOption,
  updateService,
} from "@/server/catalogue-admin";

const TZ = "Europe/London";
let db: Db;
let sw: s.Venue;
let lk: s.Venue;
let owner: CurrentUser;
let lkStaff: CurrentUser;
let swManager: CurrentUser;
let workshops: s.Service;

/** A local date at least a week out that falls on a Wednesday (South Woodford is open). */
function futureWednesday(): string {
  let d = addDays(localDate(new Date(), TZ), 7);
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 3) d = addDays(d, 1);
  return d;
}

async function lastAudit(action: string) {
  const [row] = await db.select().from(s.auditLog).where(eq(s.auditLog.action, action)).orderBy(desc(s.auditLog.createdAt)).limit(1);
  return row;
}

beforeAll(async () => {
  db = await createTestDb({ seed: true });
  [sw] = await db.select().from(s.venues).where(eq(s.venues.slug, "south-woodford"));
  [lk] = await db.select().from(s.venues).where(eq(s.venues.slug, "lakeside"));
  const [ownerRow] = await db.select().from(s.users).where(eq(s.users.isOwner, true));
  owner = { id: ownerRow.id, email: ownerRow.email, name: ownerRow.name, isOwner: true, venues: [] };
  lkStaff = { id: ownerRow.id, email: "staff@example.com", name: "Staff", isOwner: false, venues: [{ venueId: lk.id, role: "staff" }] };
  swManager = { id: ownerRow.id, email: "mgr@example.com", name: "Manager", isOwner: false, venues: [{ venueId: sw.id, role: "manager" }] };
  [workshops] = await db.select().from(s.services).where(and(eq(s.services.venueId, sw.id), eq(s.services.slug, "classic-workshops")));
});

describe("pure helpers", () => {
  it("converts pounds to pence", () => {
    expect(poundsToPence("18")).toBe(1800);
    expect(poundsToPence("£17.5")).toBe(1750);
    expect(poundsToPence("0.05")).toBe(5);
    expect(Number.isNaN(poundsToPence("abc"))).toBe(true);
    expect(Number.isNaN(poundsToPence("1.234"))).toBe(true);
  });

  it("makes hourly starts up to one length before close", () => {
    expect(hourlyStarts({ open: "10:00", close: "13:00" }, 60)).toEqual(["10:00", "11:00", "12:00"]);
    expect(hourlyStarts({ open: "10:00", close: "13:00" }, 90)).toEqual(["10:00", "11:00"]);
    expect(hourlyStarts(null, 60)).toEqual([]);
  });
});

describe("options and add-ons", () => {
  it("changes an option price and audits before/after", async () => {
    const services = await listServicesForVenue(db, sw.id);
    const slime = services.find((x) => x.slug === "classic-workshops")!.options.find((o) => o.name === "Slime Workshop")!;
    expect(slime.unitPricePence).toBe(1700);

    const updated = await updateOption(db, owner, slime.id, { unitPricePence: poundsToPence("18") });
    expect(updated.unitPricePence).toBe(1800);
    const [row] = await db.select().from(s.serviceOptions).where(eq(s.serviceOptions.id, slime.id));
    expect(row.unitPricePence).toBe(1800);
    expect(row.name).toBe("Slime Workshop");

    const a = await lastAudit("option.update");
    expect(a.entityId).toBe(slime.id);
    expect(a.venueId).toBe(sw.id);
    expect((a.before as { unitPricePence: number }).unitPricePence).toBe(1700);
    expect((a.after as { unitPricePence: number }).unitPricePence).toBe(1800);
  });

  it("archiving an option hides it from listServicesForVenue", async () => {
    const opt = await createOption(db, owner, workshops.id, { name: "Glitter Workshop", unitPricePence: 1200 });
    let svc = (await listServicesForVenue(db, sw.id)).find((x) => x.id === workshops.id)!;
    expect(svc.options.map((o) => o.id)).toContain(opt.id);

    await setOptionArchived(db, owner, opt.id, true);
    svc = (await listServicesForVenue(db, sw.id)).find((x) => x.id === workshops.id)!;
    expect(svc.options.map((o) => o.id)).not.toContain(opt.id);
    expect((await lastAudit("option.archive")).entityId).toBe(opt.id);

    await setOptionArchived(db, owner, opt.id, false);
    svc = (await listServicesForVenue(db, sw.id)).find((x) => x.id === workshops.id)!;
    expect(svc.options.map((o) => o.id)).toContain(opt.id);
  });

  it("validates input with friendly messages", async () => {
    await expect(updateOption(db, owner, (await createOption(db, owner, workshops.id, { name: "Tmp", unitPricePence: 100 })).id, { unitPricePence: Number.NaN })).rejects.toThrow(
      /Price/,
    );
    await expect(createAddOn(db, owner, workshops.id, { name: "Food time", pricePence: 5000, kind: "time", extraMinutes: 0 })).rejects.toThrow(/Extra minutes/);
    const addOn = await createAddOn(db, owner, workshops.id, { name: "Goody bag", pricePence: 300, maxQuantity: 5 });
    expect(addOn.kind).toBe("quantity");
  });
});

describe("permissions", () => {
  it("refuses staff and managers of other venues", async () => {
    await expect(updateService(db, lkStaff, workshops.id, { name: "Nope" })).rejects.toThrow(/no longer exists|owner/);
    const [lkWorkshops] = await db.select().from(s.services).where(and(eq(s.services.venueId, lk.id), eq(s.services.slug, "classic-workshops")));
    await expect(updateService(db, lkStaff, lkWorkshops.id, { name: "Nope" })).rejects.toThrow(/owner or a manager/);
    await expect(updateService(db, swManager, lkWorkshops.id, { name: "Nope" })).rejects.toThrow();
    const ok = await updateService(db, swManager, workshops.id, { blurb: "Edited by the manager." });
    expect(ok.blurb).toBe("Edited by the manager.");
  });
});

describe("services", () => {
  it("creates a service with a unique slug at the end, and reorders", async () => {
    const [room] = await db.select().from(s.rooms).where(eq(s.rooms.venueId, sw.id));
    const a = await createService(db, owner, { venueId: sw.id, kind: "session", name: "Classic Workshops", roomId: room.id, lengthMinutes: 45 });
    expect(a.slug).toBe("classic-workshops-2");
    const before = await listServicesForVenue(db, sw.id);
    expect(before[before.length - 1].id).toBe(a.id);

    await moveService(db, owner, a.id, "up");
    const after = await listServicesForVenue(db, sw.id);
    expect(after[after.length - 2].id).toBe(a.id);
    expect((await lastAudit("service.reorder")).entityId).toBe(a.id);
  });
});

describe("timetable, exceptions and sessions", () => {
  it("adding a rule then ensureSessions adds the occurrence; deleting removes it", async () => {
    const date = futureWednesday();
    const startsAt = zonedDateTime(date, "18:30", TZ);
    const res = await addTimetableRules(db, owner, workshops.id, { weekdays: [3], startTime: "18:30", capacity: 6 });
    expect(res.added).toBe(1);
    const again = await addTimetableRules(db, owner, workshops.id, { weekdays: [3], startTime: "18:30", capacity: 6 });
    expect(again).toEqual({ added: 0, skipped: 1 });

    const [occ] = await db.select().from(s.sessions).where(and(eq(s.sessions.serviceId, workshops.id), eq(s.sessions.startsAt, startsAt)));
    expect(occ?.capacity).toBe(6);

    const [rule] = await db
      .select()
      .from(s.timetableRules)
      .where(and(eq(s.timetableRules.serviceId, workshops.id), eq(s.timetableRules.startTime, "18:30")));
    await deleteTimetableRule(db, owner, rule.id);
    const gone = await db.select().from(s.sessions).where(and(eq(s.sessions.serviceId, workshops.id), eq(s.sessions.startsAt, startsAt)));
    expect(gone).toHaveLength(0);
  });

  it("a capacity exception changes that occurrence", async () => {
    const date = futureWednesday();
    const startsAt = zonedDateTime(date, "11:00", TZ);
    const { keptWithBookings } = await addTimetableException(db, owner, workshops.id, { date, kind: "capacity", startTime: "11:00", capacity: 4 });
    expect(keptWithBookings).toBe(0);
    const [occ] = await db.select().from(s.sessions).where(and(eq(s.sessions.serviceId, workshops.id), eq(s.sessions.startsAt, startsAt)));
    expect(occ.capacity).toBe(4);
    expect((await lastAudit("exception.add")).venueId).toBe(sw.id);
  });

  it("a cancel exception removes the occurrence", async () => {
    const date = futureWednesday();
    const startsAt = zonedDateTime(date, "15:00", TZ);
    await addTimetableException(db, owner, workshops.id, { date, kind: "cancel_time", startTime: "15:00" });
    const rows = await db.select().from(s.sessions).where(and(eq(s.sessions.serviceId, workshops.id), eq(s.sessions.startsAt, startsAt)));
    expect(rows).toHaveLength(0);
    await expect(addTimetableException(db, owner, workshops.id, { date: "2020-01-01", kind: "cancel_day" })).rejects.toBeInstanceOf(AdminError);
  });

  it("fills from opening hours, adding only missing times", async () => {
    const [room] = await db.select().from(s.rooms).where(eq(s.rooms.venueId, sw.id));
    const svc = await createService(db, owner, { venueId: sw.id, kind: "session", name: "Mini Workshop", roomId: room.id, lengthMinutes: 60 });
    await addTimetableRules(db, owner, svc.id, { weekdays: [2], startTime: "10:00", capacity: 8 });
    const { added } = await fillTimetableFromOpeningHours(db, owner, svc.id);
    // South Woodford: Tue–Sun 10:00–18:00 -> 8 starts a day × 6 days, minus the one that existed.
    expect(added).toBe(47);
    const rules = await db.select().from(s.timetableRules).where(eq(s.timetableRules.serviceId, svc.id));
    expect(rules).toHaveLength(48);
    expect(rules.every((r) => r.capacity === 8)).toBe(true);
    expect((await fillTimetableFromOpeningHours(db, owner, svc.id)).added).toBe(0);
  });

  it("changes one session's capacity (pinned), cancels and adds an extra session", async () => {
    const date = futureWednesday();
    const day = await listSessionsForDay(db, sw.id, date, TZ);
    const ten = day.find((x) => x.serviceId === workshops.id && x.startsAt.getTime() === zonedDateTime(date, "10:00", TZ).getTime())!;
    expect(ten).toBeTruthy();

    const changed = await setSessionCapacity(db, owner, ten.id, 12);
    expect(changed.capacity).toBe(12);
    expect(changed.pinned).toBe(true);

    // Book it, then cancelling needs the acknowledgement.
    const [org] = await db.select().from(s.organisations);
    const [cust] = await db.insert(s.customers).values({ organisationId: org.id, firstName: "Amira", lastName: "Khan", email: "a@example.com" }).returning();
    await db.insert(s.bookings).values({
      reference: "BP-TEST1",
      venueId: sw.id,
      serviceId: workshops.id,
      roomId: workshops.roomId,
      sessionId: ten.id,
      customerId: cust.id,
      startsAt: ten.startsAt,
      endsAt: ten.endsAt,
      status: "confirmed",
      places: 3,
      source: "manual",
      paymentMethod: "cash",
      paymentStatus: "paid",
      token: "tok-test-1",
    });
    await expect(setSessionCapacity(db, owner, ten.id, 2)).rejects.toThrow(/3 places are already booked/);
    await expect(cancelSession(db, owner, ten.id)).rejects.toThrow(/1 booking/);
    const cancelled = await cancelSession(db, owner, ten.id, { bookingsAcknowledged: true });
    expect(cancelled.status).toBe("cancelled");
    // Generation leaves the pinned, cancelled row alone.
    const after = await listSessionsForDay(db, sw.id, date, TZ);
    expect(after.find((x) => x.id === ten.id)?.status).toBe("cancelled");

    const extra = await addExtraSession(db, owner, workshops.id, { date, startTime: "09:00", capacity: 5 });
    expect(extra.capacity).toBe(5);
    expect(extra.startsAt.getTime()).toBe(zonedDateTime(date, "09:00", TZ).getTime());
    await expect(addExtraSession(db, owner, workshops.id, { date, startTime: "09:00", capacity: 5 })).rejects.toThrow(/already/);
  });
});

describe("blocks", () => {
  it("inserts a block and closes a whole day", async () => {
    const date = futureWednesday();
    const { block } = await createBlock(db, owner, {
      venueId: sw.id,
      roomId: null,
      startDate: date,
      startTime: "12:00",
      endDate: date,
      endTime: "14:00",
      reason: "Private hire",
    });
    expect(block.startsAt.getTime()).toBe(zonedDateTime(date, "12:00", TZ).getTime());
    expect(block.reason).toBe("Private hire");
    expect((await lastAudit("block.create")).entityId).toBe(block.id);

    const day = await closeWholeDay(db, owner, { venueId: sw.id, date: addDays(date, 1) });
    expect(day.block.endsAt.getTime() - day.block.startsAt.getTime()).toBe(24 * 3600_000);
    const list = await listUpcomingBlocks(db, [sw.id]);
    expect(list.map((b) => b.id)).toEqual(expect.arrayContaining([block.id, day.block.id]));

    await expect(
      createBlock(db, owner, { venueId: sw.id, roomId: null, startDate: date, startTime: "14:00", endDate: date, endTime: "12:00", reason: "x" }),
    ).rejects.toThrow(/end must be after/);
    await expect(closeWholeDay(db, lkStaff, { venueId: lk.id, date })).rejects.toThrow(/owner or a manager/);
  });
});

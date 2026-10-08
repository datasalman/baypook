import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { addMinutes, zonedDateTime } from "@/core/time";
import { PricingError } from "@/core/pricing";
import { generateReference, generateToken } from "@/core/reference";
import { getVenueBySlug } from "@/server/org";
import {
  getService,
  getServiceBySlug,
  getServiceForVenue,
  isUuid,
  listServicesForVenue,
  type ServiceWithCatalogue,
} from "@/server/catalogue";
import { AvailabilityError, assertBookable, getSessionAvailability, getSlotStarts, loadWindowState } from "@/server/availability";
import { quoteForService, toQuoteInput } from "@/server/quote";

const DAY = "2026-10-20"; // Tuesday
const NOW = new Date("2026-10-10T09:00:00Z");
const at = (time: string) => zonedDateTime(DAY, time);

type Ctx = {
  db: Db;
  sw: s.Venue;
  lk: s.Venue;
  swWorkshops: ServiceWithCatalogue;
  swParty: ServiceWithCatalogue;
  lkWorkshops: ServiceWithCatalogue;
  lkParty: ServiceWithCatalogue;
  customerId: string;
};

async function setup(): Promise<Ctx> {
  const db = await createTestDb({ seed: true });
  const sw = (await getVenueBySlug(db, "south-woodford"))!;
  const lk = (await getVenueBySlug(db, "lakeside"))!;
  const [org] = await db.select().from(s.organisations);
  const [customer] = await db
    .insert(s.customers)
    .values({ organisationId: org.id, firstName: "Amina", lastName: "Khan", email: "amina@example.com" })
    .returning();
  return {
    db,
    sw,
    lk,
    swWorkshops: (await getServiceBySlug(db, sw.id, "classic-workshops"))!,
    swParty: (await getServiceBySlug(db, sw.id, "slime-party"))!,
    lkWorkshops: (await getServiceBySlug(db, lk.id, "classic-workshops"))!,
    lkParty: (await getServiceBySlug(db, lk.id, "slime-party"))!,
    customerId: customer.id,
  };
}

async function insertBooking(
  c: Ctx,
  input: { venue: s.Venue; service: ServiceWithCatalogue; sessionId?: string | null; startsAt: Date; endsAt: Date; places: number; status?: s.Booking["status"] },
): Promise<s.Booking> {
  const [row] = await c.db
    .insert(s.bookings)
    .values({
      reference: generateReference(),
      token: generateToken(),
      venueId: input.venue.id,
      serviceId: input.service.id,
      roomId: input.service.roomId,
      sessionId: input.sessionId ?? null,
      customerId: c.customerId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      places: input.places,
      status: input.status ?? "confirmed",
      source: "manual",
      paymentMethod: "cash",
    })
    .returning();
  return row;
}

async function errorOf(p: Promise<unknown>): Promise<AvailabilityError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AvailabilityError);
  return e as AvailabilityError;
}

describe("catalogue", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await setup();
  });

  it("lists a venue's services in order with options, add-ons and room", async () => {
    const list = await listServicesForVenue(c.db, c.sw.id);
    expect(list.map((x) => x.slug)).toEqual(["classic-workshops", "slime-party", "decoden-craft-party"]);
    expect(list[0].options.map((o) => o.name)).toEqual(["Slime Workshop", "Decoden Craft Workshop"]);
    expect(list[1].addOns.map((a) => a.name)).toEqual(["Extra child", "Food time"]);
    expect(list[1].room.name).toBe("Main room");
    expect(c.lkParty.room.name).toBe("Party room");
    expect(c.lkWorkshops.room.name).toBe("Workshop floor");
    expect(await listServicesForVenue(c.db, "nope")).toEqual([]);
  });

  it("hides archived and offline rows unless asked", async () => {
    const db = (await setup()).db;
    const sw = (await getVenueBySlug(db, "south-woodford"))!;
    const ws = (await getServiceBySlug(db, sw.id, "classic-workshops"))!;
    const party = (await getServiceBySlug(db, sw.id, "slime-party"))!;
    const deco = (await getServiceBySlug(db, sw.id, "decoden-craft-party"))!;
    await db.update(s.serviceOptions).set({ archivedAt: new Date() }).where(eq(s.serviceOptions.id, ws.options[1].id));
    await db.update(s.addOns).set({ archivedAt: new Date() }).where(eq(s.addOns.id, party.addOns[1].id));
    await db.update(s.services).set({ onlineEnabled: false }).where(eq(s.services.id, party.id));
    await db.update(s.services).set({ archivedAt: new Date() }).where(eq(s.services.id, deco.id));

    expect((await getService(db, ws.id))!.options).toHaveLength(1);
    expect((await getService(db, ws.id, { includeArchived: true }))!.options).toHaveLength(2);
    expect((await getService(db, party.id))!.addOns).toHaveLength(1);
    expect(await getService(db, deco.id)).toBeNull();
    expect(await getService(db, deco.id, { includeArchived: true })).not.toBeNull();
    expect(await getServiceBySlug(db, sw.id, "decoden-craft-party")).toBeNull();
    expect((await listServicesForVenue(db, sw.id)).map((x) => x.slug)).toEqual(["classic-workshops", "slime-party"]);
    expect((await listServicesForVenue(db, sw.id, { onlineOnly: true })).map((x) => x.slug)).toEqual(["classic-workshops"]);
    expect(await listServicesForVenue(db, sw.id, { includeArchived: true })).toHaveLength(3);
  });

  it("finds a service by id or slug within a venue", async () => {
    expect((await getServiceForVenue(c.db, c.sw.id, c.swParty.id))!.id).toBe(c.swParty.id);
    expect((await getServiceForVenue(c.db, c.sw.id, "slime-party"))!.id).toBe(c.swParty.id);
    expect(await getServiceForVenue(c.db, c.lk.id, c.swParty.id)).toBeNull();
    expect(await getService(c.db, "not-a-uuid")).toBeNull();
    expect(await getServiceBySlug(c.db, "not-a-uuid", "slime-party")).toBeNull();
    expect(isUuid(c.sw.id)).toBe(true);
    expect(isUuid(42)).toBe(false);
  });

  it("quotes from the catalogue rows", () => {
    const extra = c.swParty.addOns.find((a) => a.perChild)!;
    const q = quoteForService(c.db, {
      service: c.swParty,
      venue: c.sw,
      lines: [{ optionId: c.swParty.options[0].id, qty: 1 }],
      addOns: [{ addOnId: extra.id, qty: 3 }],
    });
    expect(q.totalPence).toBe(24800);
    expect(q.places).toBe(13);
    const input = toQuoteInput({ service: c.swWorkshops, venue: c.sw, lines: [], addOns: [] });
    expect(input).toMatchObject({ serviceKind: "session", maxPlacesPerBooking: 10 });
    expect(() => quoteForService(null, { service: c.swWorkshops, venue: c.sw, lines: [], addOns: [] })).toThrow(PricingError);
  });
});

describe("availability from the database", () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
  });

  it("materialises and reports the day's workshop sessions", async () => {
    const avail = await getSessionAvailability(c.db, { venue: c.sw, service: c.swWorkshops, from: DAY, to: DAY, now: NOW });
    expect(avail).toHaveLength(8);
    expect(avail[0].startsAt.toISOString()).toBe("2026-10-20T09:00:00.000Z");
    expect(avail.every((a) => a.bookable && a.remaining === 10)).toBe(true);
    expect(await getSessionAvailability(c.db, { venue: c.sw, service: c.swParty, from: DAY, to: DAY, now: NOW })).toEqual([]);
  });

  it("lists party starts and checks Food time length", async () => {
    const starts = await getSlotStarts(c.db, { venue: c.sw, service: c.swParty, day: DAY, extraMinutes: 0, now: NOW });
    expect(starts).toHaveLength(14);
    expect(starts.every((x) => x.bookable)).toBe(true);
    const withFood = await getSlotStarts(c.db, { venue: c.sw, service: c.swParty, day: DAY, extraMinutes: 30, now: NOW });
    expect(withFood).toHaveLength(13);
    expect(await getSlotStarts(c.db, { venue: c.sw, service: c.swWorkshops, day: DAY, extraMinutes: 0, now: NOW })).toEqual([]);
  });

  it("a confirmed party blocks the sessions it overlaps; a Food-time party blocks one more", async () => {
    await insertBooking(c, { venue: c.sw, service: c.swParty, startsAt: at("10:30"), endsAt: at("12:30"), places: 10 });
    const avail = await getSessionAvailability(c.db, { venue: c.sw, service: c.swWorkshops, from: DAY, to: DAY, now: NOW });
    const reasons = avail.map((a) => a.reason);
    expect(reasons).toEqual(["room_busy", "room_busy", "room_busy", null, null, null, null, null]);
  });

  it("at Lakeside the party room does not cross-block the workshop floor", async () => {
    await insertBooking(c, { venue: c.lk, service: c.lkParty, startsAt: at("10:00"), endsAt: at("12:00"), places: 12 });
    const avail = await getSessionAvailability(c.db, { venue: c.lk, service: c.lkWorkshops, from: DAY, to: DAY, now: NOW });
    expect(avail).toHaveLength(10);
    expect(avail.every((a) => a.bookable)).toBe(true);

    const ws = avail[0];
    await insertBooking(c, { venue: c.lk, service: c.lkWorkshops, sessionId: ws.sessionId, startsAt: ws.startsAt, endsAt: ws.endsAt, places: 4 });
    const starts = await getSlotStarts(c.db, { venue: c.lk, service: c.lkParty, day: DAY, extraMinutes: 0, now: NOW });
    // 10:00 is taken by the party itself; 12:00 onwards is free despite the booked workshop on the floor.
    expect(starts.find((x) => x.startsAt.getTime() === at("10:00").getTime())!.reason).toBe("room_busy");
    expect(starts.find((x) => x.startsAt.getTime() === at("12:00").getTime())!.bookable).toBe(true);
  });

  it("blocks: a venue-wide block closes sessions and slots", async () => {
    await c.db.insert(s.blocks).values({ venueId: c.sw.id, roomId: null, startsAt: at("14:00"), endsAt: at("16:00"), reason: "Private hire" });
    const avail = await getSessionAvailability(c.db, { venue: c.sw, service: c.swWorkshops, from: DAY, to: DAY, now: NOW });
    expect(avail.filter((a) => a.reason === "blocked").map((a) => a.startsAt.getTime())).toEqual([at("14:00").getTime(), at("15:00").getTime()]);
    const starts = await getSlotStarts(c.db, { venue: c.sw, service: c.swParty, day: DAY, extraMinutes: 0, now: NOW });
    expect(starts.find((x) => x.startsAt.getTime() === at("12:30").getTime())!.bookable).toBe(true); // ends 14:00
    expect(starts.find((x) => x.startsAt.getTime() === at("13:00").getTime())!.reason).toBe("blocked");
    expect(starts.find((x) => x.startsAt.getTime() === at("16:00").getTime())!.bookable).toBe(true);
  });

  it("loadWindowState returns room-filtered state with service kinds", async () => {
    const avail = await getSessionAvailability(c.db, { venue: c.lk, service: c.lkWorkshops, from: DAY, to: DAY, now: NOW });
    await insertBooking(c, { venue: c.lk, service: c.lkParty, startsAt: at("10:00"), endsAt: at("11:30"), places: 10 });
    await insertBooking(c, { venue: c.lk, service: c.lkWorkshops, sessionId: avail[0].sessionId, startsAt: avail[0].startsAt, endsAt: avail[0].endsAt, places: 2, status: "cancelled" });
    await c.db.insert(s.blocks).values({ venueId: c.lk.id, roomId: c.lkParty.roomId, startsAt: at("17:00"), endsAt: at("18:00") });
    const window = { venueId: c.lk.id, from: at("00:00"), to: addMinutes(at("00:00"), 24 * 60), now: NOW };
    const floor = await loadWindowState(c.db, { ...window, roomId: c.lkWorkshops.roomId });
    expect(floor.bookings).toEqual([]); // the party is in the other room; the workshop booking is cancelled
    expect(floor.blocks).toEqual([]);
    expect(floor.sessions).toHaveLength(10);
    const all = await loadWindowState(c.db, window);
    expect(all.bookings.map((b) => b.serviceKind)).toEqual(["slot"]);
    expect(all.blocks).toHaveLength(1);
  });
});

describe("assertBookable", () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
  });

  it("excludeBookingId lets a booking be re-checked or moved onto its own time", async () => {
    const booking = await insertBooking(c, { venue: c.sw, service: c.swParty, startsAt: at("12:00"), endsAt: at("13:30"), places: 10 });
    const input = { venue: c.sw, service: c.swParty, startsAt: at("12:30"), endsAt: at("14:00"), places: 10, now: NOW };
    const err = await errorOf(assertBookable(c.db, input));
    expect(err).toMatchObject({ code: "GONE", reason: "room_busy" });
    await expect(assertBookable(c.db, { ...input, excludeBookingId: booking.id })).resolves.toEqual({
      sessionId: null,
      startsAt: at("12:30"),
      endsAt: at("14:00"),
    });
  });

  it("excludeBookingId frees a session booking's own places when changing counts", async () => {
    const [ten] = await getSessionAvailability(c.db, { venue: c.sw, service: c.swWorkshops, from: DAY, to: DAY, now: NOW });
    const booking = await insertBooking(c, { venue: c.sw, service: c.swWorkshops, sessionId: ten.sessionId, startsAt: ten.startsAt, endsAt: ten.endsAt, places: 8 });
    const input = { venue: c.sw, service: c.swWorkshops, sessionId: ten.sessionId, startsAt: ten.startsAt, endsAt: ten.endsAt, places: 9, now: NOW };
    expect(await errorOf(assertBookable(c.db, input))).toMatchObject({ code: "LIMIT", limit: 2 });
    const ok = await assertBookable(c.db, { ...input, excludeBookingId: booking.id });
    expect(ok.sessionId).toBe(ten.sessionId);
    expect(ok.startsAt.getTime()).toBe(ten.startsAt.getTime());
  });

  it("ignoreTiming allows an admin booking inside the cut-off", async () => {
    const [ten] = await getSessionAvailability(c.db, { venue: c.sw, service: c.swWorkshops, from: DAY, to: DAY, now: NOW });
    const now = addMinutes(ten.startsAt, -10);
    const input = { venue: c.sw, service: c.swWorkshops, sessionId: ten.sessionId, startsAt: ten.startsAt, endsAt: ten.endsAt, places: 2, now };
    expect(await errorOf(assertBookable(c.db, input))).toMatchObject({ code: "GONE", reason: "cutoff" });
    await expect(assertBookable(c.db, { ...input, ignoreTiming: true })).resolves.toMatchObject({ sessionId: ten.sessionId });
  });

  it("validates its input", async () => {
    const base = { venue: c.sw, service: c.swParty, startsAt: at("12:00"), endsAt: at("13:30"), places: 10, now: NOW };
    expect((await errorOf(assertBookable(c.db, { ...base, venue: c.lk }))).code).toBe("INVALID");
    expect((await errorOf(assertBookable(c.db, { ...base, places: 0 }))).code).toBe("INVALID");
    expect((await errorOf(assertBookable(c.db, { ...base, endsAt: at("12:00") }))).code).toBe("INVALID");
    const ws = { ...base, service: c.swWorkshops };
    expect((await errorOf(assertBookable(c.db, { ...ws, sessionId: null }))).code).toBe("INVALID");
    expect((await errorOf(assertBookable(c.db, { ...ws, sessionId: "00000000-0000-4000-8000-000000000000" }))).code).toBe("INVALID");
  });

  it("reports a cancelled session as GONE", async () => {
    const [ten] = await getSessionAvailability(c.db, { venue: c.sw, service: c.swWorkshops, from: DAY, to: DAY, now: NOW });
    await c.db.update(s.sessions).set({ status: "cancelled", pinned: true }).where(eq(s.sessions.id, ten.sessionId));
    const err = await errorOf(
      assertBookable(c.db, { venue: c.sw, service: c.swWorkshops, sessionId: ten.sessionId, startsAt: ten.startsAt, endsAt: ten.endsAt, places: 1, now: NOW }),
    );
    expect(err).toMatchObject({ code: "GONE", reason: "cancelled" });
  });

  it("works inside a transaction (row locks)", async () => {
    const result = await c.db.transaction((tx) =>
      assertBookable(tx, { venue: c.sw, service: c.swParty, startsAt: at("15:00"), endsAt: at("16:30"), places: 10, now: NOW }),
    );
    expect(result.sessionId).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { addMinutes, zonedDateTime } from "@/core/time";
import { getVenueBySlug } from "@/server/org";
import { getServiceBySlug, type ServiceWithCatalogue } from "@/server/catalogue";
import { getSessionAvailability, getSlotStarts } from "@/server/availability";
import {
  attachHoldToBooking,
  createHold,
  expireHolds,
  extendHold,
  getActiveHold,
  getHold,
  HoldError,
  markHoldConverted,
  releaseHold,
  setHoldCheckout,
} from "@/server/holds";

const DAY = "2026-10-20"; // Tuesday
const NOW = new Date("2026-10-10T09:00:00Z");
const TEN = zonedDateTime(DAY, "10:00");

type Ctx = { db: Db; venue: s.Venue; workshops: ServiceWithCatalogue; party: ServiceWithCatalogue; sessionId: string };

async function setup(): Promise<Ctx> {
  const db = await createTestDb({ seed: true });
  const venue = (await getVenueBySlug(db, "south-woodford"))!;
  const workshops = (await getServiceBySlug(db, venue.id, "classic-workshops"))!;
  const party = (await getServiceBySlug(db, venue.id, "slime-party"))!;
  const avail = await getSessionAvailability(db, { venue, service: workshops, from: DAY, to: DAY, now: NOW });
  const ten = avail.find((a) => a.startsAt.getTime() === TEN.getTime())!;
  return { db, venue, workshops, party, sessionId: ten.sessionId };
}

const slime = (c: Ctx) => c.workshops.options.find((o) => o.name === "Slime Workshop")!.id;
const extraChild = (c: Ctx) => c.party.addOns.find((a) => a.name === "Extra child")!.id;
const foodTime = (c: Ctx) => c.party.addOns.find((a) => a.name === "Food time")!.id;
const pkg = (c: Ctx) => c.party.options[0].id;

function holdPlaces(c: Ctx, qty: number, now = NOW, holdMinutes = 15) {
  return createHold(c.db, {
    venue: c.venue,
    service: c.workshops,
    holdMinutes,
    sessionId: c.sessionId,
    lines: [{ optionId: slime(c), qty }],
    addOns: [],
    now,
  });
}

function holdParty(c: Ctx, time: string, addOns: { addOnId: string; qty: number }[] = [], now = NOW) {
  return createHold(c.db, {
    venue: c.venue,
    service: c.party,
    holdMinutes: 15,
    startsAt: zonedDateTime(DAY, time),
    lines: [{ optionId: pkg(c), qty: 1 }],
    addOns,
    now,
  });
}

async function expectHoldError(p: Promise<unknown>, code: HoldError["code"], extra: { limit?: number; reason?: string } = {}) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HoldError);
  expect((err as HoldError).code).toBe(code);
  if (extra.limit !== undefined) expect((err as HoldError).limit).toBe(extra.limit);
  if (extra.reason !== undefined) expect((err as HoldError).reason).toBe(extra.reason);
}

async function remainingAt(c: Ctx, now: Date) {
  const avail = await getSessionAvailability(c.db, { venue: c.venue, service: c.workshops, from: DAY, to: DAY, now });
  return avail.find((a) => a.sessionId === c.sessionId)!;
}

describe("createHold", () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
  });

  it("holds places on a session with a server-side quote", async () => {
    const { hold, quote } = await holdPlaces(c, 2);
    expect(quote).toMatchObject({ totalPence: 3400, places: 2 });
    expect(hold).toMatchObject({
      status: "active",
      places: 2,
      sessionId: c.sessionId,
      venueId: c.venue.id,
      serviceId: c.workshops.id,
      roomId: c.workshops.roomId,
      lines: [{ optionId: slime(c), qty: 2 }],
      addOns: [],
    });
    expect(hold.startsAt.getTime()).toBe(TEN.getTime());
    expect(hold.endsAt.getTime()).toBe(addMinutes(TEN, 60).getTime());
    expect(hold.expiresAt.getTime()).toBe(addMinutes(NOW, 15).getTime());
    expect(await remainingAt(c, NOW)).toMatchObject({ taken: 0, held: 2, remaining: 8 });
  });

  it("two holds on the last place: the second is GONE", async () => {
    await holdPlaces(c, 9);
    await holdPlaces(c, 1); // the last place
    await expectHoldError(holdPlaces(c, 1), "GONE", { reason: "full" });
    expect(await remainingAt(c, NOW)).toMatchObject({ remaining: 0, bookable: false, reason: "full" });
  });

  it("asking for more than remain is LIMIT with the number left", async () => {
    await holdPlaces(c, 8);
    await expectHoldError(holdPlaces(c, 3), "LIMIT", { limit: 2 });
  });

  it("maps pricing errors: 11 places is LIMIT 10, nothing chosen is INVALID", async () => {
    await expectHoldError(holdPlaces(c, 11), "LIMIT", { limit: 10 });
    await expectHoldError(holdPlaces(c, 0), "INVALID");
  });

  it("needs a session for a workshop and a start for a party", async () => {
    await expectHoldError(
      createHold(c.db, { venue: c.venue, service: c.workshops, holdMinutes: 15, lines: [{ optionId: slime(c), qty: 1 }], addOns: [], now: NOW }),
      "INVALID",
    );
    await expectHoldError(
      createHold(c.db, { venue: c.venue, service: c.workshops, holdMinutes: 15, sessionId: "not-a-uuid", lines: [{ optionId: slime(c), qty: 1 }], addOns: [], now: NOW }),
      "INVALID",
    );
    await expectHoldError(
      createHold(c.db, { venue: c.venue, service: c.party, holdMinutes: 15, startsAt: null, lines: [{ optionId: pkg(c), qty: 1 }], addOns: [], now: NOW }),
      "INVALID",
    );
  });

  it("refuses a service from another venue", async () => {
    const lakeside = (await getVenueBySlug(c.db, "lakeside"))!;
    await expectHoldError(
      createHold(c.db, { venue: lakeside, service: c.workshops, holdMinutes: 15, sessionId: c.sessionId, lines: [{ optionId: slime(c), qty: 1 }], addOns: [], now: NOW }),
      "INVALID",
    );
  });

  it("refuses a workshop inside the cut-off", async () => {
    await expectHoldError(holdPlaces(c, 1, addMinutes(TEN, -30)), "GONE", { reason: "cutoff" });
  });

  it("holds a party slot including Food time and extra children", async () => {
    const { hold, quote } = await holdParty(c, "12:00", [
      { addOnId: extraChild(c), qty: 3 },
      { addOnId: foodTime(c), qty: 1 },
    ]);
    expect(quote.totalPence).toBe(20000 + 4800 + 5000);
    expect(hold.places).toBe(13);
    expect(hold.sessionId).toBeNull();
    expect(hold.endsAt.getTime()).toBe(zonedDateTime(DAY, "14:00").getTime());
    // A second party overlapping the first is GONE; one starting as it ends is fine.
    await expectHoldError(holdParty(c, "13:30"), "GONE", { reason: "room_busy" });
    await holdParty(c, "14:00");
  });

  it("a party needs 48 hours' notice", async () => {
    await expectHoldError(holdParty(c, "12:00", [], new Date("2026-10-18T12:00:00Z")), "GONE", { reason: "lead_time" });
  });

  it("a party over an empty session succeeds and the session then shows unavailable", async () => {
    await holdParty(c, "10:00");
    expect(await remainingAt(c, NOW)).toMatchObject({ bookable: false, reason: "room_busy" });
    await expectHoldError(holdPlaces(c, 1), "GONE", { reason: "room_busy" });
  });

  it("a held workshop place refuses an overlapping party", async () => {
    await holdPlaces(c, 1);
    await expectHoldError(holdParty(c, "09:30"), "GONE"); // before opening: closed
    await expectHoldError(holdParty(c, "10:00"), "GONE", { reason: "room_busy" });
    const starts = await getSlotStarts(c.db, { venue: c.venue, service: c.party, day: DAY, extraMinutes: 0, now: NOW });
    expect(starts.find((x) => x.startsAt.getTime() === TEN.getTime())!.reason).toBe("room_busy");
    expect(starts.find((x) => x.startsAt.getTime() === addMinutes(TEN, 60).getTime())!.bookable).toBe(true);
  });
});

describe("hold lifecycle", () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
  });

  it("expired holds are ignored by availability and marked expired by expireHolds", async () => {
    const { hold } = await holdPlaces(c, 10);
    const later = addMinutes(NOW, 15); // expiresAt == now: no longer live
    expect(await remainingAt(c, addMinutes(NOW, 14))).toMatchObject({ remaining: 0 });
    expect(await remainingAt(c, later)).toMatchObject({ held: 0, remaining: 10, bookable: true });
    await holdPlaces(c, 10, later); // the places can be held again

    await setHoldCheckout(c.db, hold.id, "cs_test_1");
    const result = await expireHolds(c.db, later);
    expect(result).toEqual({ expired: 1, checkoutIds: ["cs_test_1"], bookingIds: [] });
    expect((await getHold(c.db, hold.id))!.status).toBe("expired");
    await expectHoldError(getActiveHold(c.db, hold.id, later), "HOLD_EXPIRED");
    expect(await expireHolds(c.db, later)).toEqual({ expired: 0, checkoutIds: [], bookingIds: [] });
  });

  it("reports the pending bookings attached to expiring holds", async () => {
    const { hold } = await holdPlaces(c, 2);
    const bookingId = "00000000-0000-4000-8000-000000000001";
    await attachHoldToBooking(c.db, hold.id, { bookingId, checkoutId: "cs_test_2" });
    // Attached holds are no longer counted (the pending booking counts instead).
    expect(await remainingAt(c, NOW)).toMatchObject({ held: 0 });
    const result = await expireHolds(c.db, addMinutes(NOW, 20));
    expect(result).toEqual({ expired: 1, checkoutIds: ["cs_test_2"], bookingIds: [bookingId] });
  });

  it("getActiveHold: NOT_FOUND, active, then HOLD_EXPIRED once released or converted", async () => {
    await expectHoldError(getActiveHold(c.db, "00000000-0000-4000-8000-000000000000", NOW), "NOT_FOUND");
    await expectHoldError(getActiveHold(c.db, "nonsense", NOW), "NOT_FOUND");
    expect(await getHold(c.db, "nonsense")).toBeNull();

    const a = (await holdPlaces(c, 1)).hold;
    expect((await getActiveHold(c.db, a.id, NOW)).id).toBe(a.id);
    expect(await releaseHold(c.db, a.id)).toBe(true);
    expect(await releaseHold(c.db, a.id)).toBe(false);
    expect(await releaseHold(c.db, "nonsense")).toBe(false);
    await expectHoldError(getActiveHold(c.db, a.id, NOW), "HOLD_EXPIRED");
    expect(await remainingAt(c, NOW)).toMatchObject({ held: 0, remaining: 10 });

    const b = (await holdPlaces(c, 1)).hold;
    const bookingId = "00000000-0000-4000-8000-000000000002";
    await markHoldConverted(c.db, b.id, bookingId);
    const converted = (await getHold(c.db, b.id))!;
    expect(converted).toMatchObject({ status: "converted", bookingId });
    await expectHoldError(getActiveHold(c.db, b.id, NOW), "HOLD_EXPIRED");
  });

  it("extendHold pushes an active hold's expiry later", async () => {
    const { hold } = await holdPlaces(c, 1);
    const extended = await extendHold(c.db, hold.id, 20);
    expect(extended!.expiresAt.getTime()).toBe(addMinutes(NOW, 35).getTime());
    expect((await getActiveHold(c.db, hold.id, addMinutes(NOW, 30))).id).toBe(hold.id);
    await releaseHold(c.db, hold.id);
    expect(await extendHold(c.db, hold.id, 20)).toBeNull();
    expect(await extendHold(c.db, "nonsense", 20)).toBeNull();
  });

  it("stores holds in the holds table", async () => {
    const { hold } = await holdPlaces(c, 3);
    const rows = await c.db.select().from(s.holds).where(eq(s.holds.id, hold.id));
    expect(rows).toHaveLength(1);
  });
});

process.env.BAYPOOK_MODE = "demo";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { zonedDateTime } from "@/core/time";
import { DemoCalendarProvider } from "@/providers/calendar/demo";
import { calendarSummary, listCalendarLog, syncBookingToCalendar } from "@/server/calendar";

let db: Db;
let sw: s.Venue;
let lk: s.Venue;
let customer: s.Customer;
let workshops: s.Service;
let party: s.Service;
let slimeOptionId: string;
let refCounter = 0;

async function insertBooking(over: Partial<typeof s.bookings.$inferInsert> = {}): Promise<s.Booking> {
  refCounter++;
  const [b] = await db
    .insert(s.bookings)
    .values({
      reference: `BP-CAL${refCounter}`,
      token: `cal-tok-${refCounter}`,
      venueId: sw.id,
      serviceId: workshops.id,
      roomId: workshops.roomId,
      customerId: customer.id,
      startsAt: zonedDateTime("2026-10-24", "14:00", "Europe/London"),
      endsAt: zonedDateTime("2026-10-24", "15:00", "Europe/London"),
      status: "confirmed",
      lines: [{ optionId: slimeOptionId, name: "Slime Workshop", qty: 2, unitPence: 1700, totalPence: 3400 }],
      places: 2,
      totalPence: 3400,
      subtotalPence: 3400,
      paidPence: 3400,
      source: "online",
      paymentMethod: "online_card",
      paymentStatus: "paid",
      notes: "Nut allergy",
      ...over,
    })
    .returning();
  return b;
}

async function bookingRow(id: string): Promise<s.Booking> {
  const [b] = await db.select().from(s.bookings).where(eq(s.bookings.id, id));
  return b;
}

beforeAll(async () => {
  db = await createTestDb({ seed: true });
  [sw] = await db.select().from(s.venues).where(eq(s.venues.slug, "south-woodford"));
  [lk] = await db.select().from(s.venues).where(eq(s.venues.slug, "lakeside"));
  [workshops] = await db.select().from(s.services).where(and(eq(s.services.venueId, sw.id), eq(s.services.slug, "classic-workshops")));
  [party] = await db.select().from(s.services).where(and(eq(s.services.venueId, sw.id), eq(s.services.slug, "slime-party")));
  const opts = await db.select().from(s.serviceOptions).where(eq(s.serviceOptions.serviceId, workshops.id));
  slimeOptionId = opts.find((o) => o.name === "Slime Workshop")!.id;
  const [org] = await db.select().from(s.organisations);
  [customer] = await db
    .insert(s.customers)
    .values({ organisationId: org.id, firstName: "Amina", lastName: "Khan", email: "amina@example.com", phone: "07700 900123" })
    .returning();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.BAYPOOK_MODE = "demo";
});

describe("syncBookingToCalendar (demo)", () => {
  it("create logs a demo row and stores the event id; update reuses it; delete clears it", async () => {
    const b = await insertBooking();

    const created = await syncBookingToCalendar(db, b.id, "create");
    expect(created).not.toBeNull();
    expect(created!.provider).toBe("demo");
    expect(created!.action).toBe("create");
    expect(created!.status).toBe("demo");
    expect(created!.error).toBeNull();
    expect(created!.venueId).toBe(sw.id);
    expect(created!.providerEventId).toBe(`demo_evt_${b.id}`);
    const payload = created!.payload as Record<string, string>;
    expect(payload.calendarId).toBe("demo");
    expect(payload.summary).toBe("Classic Workshops – Amina (2)");
    expect(payload.location).toBe("South Woodford, 53A George Lane, South Woodford, London E18 1LN");
    expect(payload.start).toBe("2026-10-24T13:00:00.000Z");
    expect(payload.description).toContain("Reference BP-CAL");
    expect(payload.description).toContain("07700 900123");
    expect(payload.description).toContain("amina@example.com");
    expect(payload.description).toContain("2 × Slime Workshop  £34.00");
    expect(payload.description).toContain("Nut allergy");
    expect(payload.description).toContain(`/admin/bookings/${b.id}`);
    expect((await bookingRow(b.id)).googleEventId).toBe(`demo_evt_${b.id}`);

    const createSpy = vi.spyOn(DemoCalendarProvider.prototype, "createEvent");
    const updateSpy = vi.spyOn(DemoCalendarProvider.prototype, "updateEvent");

    // A second create becomes an update of the same event.
    const again = await syncBookingToCalendar(db, b.id, "create");
    expect(again!.action).toBe("update");
    expect(again!.providerEventId).toBe(`demo_evt_${b.id}`);

    const updated = await syncBookingToCalendar(db, b.id, "update");
    expect(updated!.action).toBe("update");
    expect(updated!.status).toBe("demo");
    expect(updated!.providerEventId).toBe(`demo_evt_${b.id}`);
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect((updateSpy.mock.calls[0] as unknown[])[0]).toBe(`demo_evt_${b.id}`);

    const deleted = await syncBookingToCalendar(db, b.id, "delete");
    expect(deleted!.action).toBe("delete");
    expect(deleted!.status).toBe("demo");
    expect(deleted!.providerEventId).toBe(`demo_evt_${b.id}`);
    expect((await bookingRow(b.id)).googleEventId).toBeNull();

    // Deleting again is a logged no-op.
    const deleteSpy = vi.spyOn(DemoCalendarProvider.prototype, "deleteEvent");
    const noop = await syncBookingToCalendar(db, b.id, "delete");
    expect(noop!.status).toBe("demo");
    expect(noop!.providerEventId).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();

    const log = await listCalendarLog(db, { venueIds: [sw.id] });
    expect(log.filter((r) => r.bookingId === b.id)).toHaveLength(5);
  });

  it("update creates the event when there is none yet", async () => {
    const b = await insertBooking();
    const r = await syncBookingToCalendar(db, b.id, "update");
    expect(r!.action).toBe("create");
    expect((await bookingRow(b.id)).googleEventId).toBe(`demo_evt_${b.id}`);
  });

  it("uses the birthday child and children count for party slots", async () => {
    const b = await insertBooking({
      serviceId: party.id,
      roomId: party.roomId,
      places: 12,
      birthdayChildFirstName: "Maya",
      birthdayChildAge: 8,
      lines: [],
    });
    const r = await syncBookingToCalendar(db, b.id, "create");
    expect((r!.payload as Record<string, string>).summary).toBe("Slime Party: Maya (12 children)");
    expect(calendarSummary({ booking: { ...b, birthdayChildFirstName: null }, customer, service: party })).toBe("Slime Party: Khan (12 children)");
  });

  it("records provider errors in the log instead of throwing", async () => {
    const b = await insertBooking();
    vi.spyOn(DemoCalendarProvider.prototype, "createEvent").mockRejectedValueOnce(new Error("calendar down"));
    const r = await syncBookingToCalendar(db, b.id, "create");
    expect(r!.status).toBe("failed");
    expect(r!.error).toBe("calendar down");
    expect((await bookingRow(b.id)).googleEventId).toBeNull();
  });

  it("re-creates an event that was removed from the calendar by hand", async () => {
    const b = await insertBooking({ googleEventId: "gone" });
    vi.spyOn(DemoCalendarProvider.prototype, "updateEvent").mockRejectedValueOnce(new Error("Google Calendar PATCH: 404 Not Found"));
    const r = await syncBookingToCalendar(db, b.id, "update");
    expect(r!.status).toBe("demo");
    expect(r!.action).toBe("create");
    expect((await bookingRow(b.id)).googleEventId).toBe(`demo_evt_${b.id}`);
  });

  it("returns null for an unknown booking", async () => {
    expect(await syncBookingToCalendar(db, "00000000-0000-4000-8000-000000000009", "create")).toBeNull();
  });
});

describe("syncBookingToCalendar (live without a calendar ID)", () => {
  it("writes a failed row and does not throw", async () => {
    const b = await insertBooking();
    process.env.BAYPOOK_MODE = "live";
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
    const r = await syncBookingToCalendar(db, b.id, "create");
    expect(r!.status).toBe("failed");
    expect(r!.error).toBe("No calendar ID for venue");
    expect((await bookingRow(b.id)).googleEventId).toBeNull();
  });

  it("pushes through the fallback adapter when the venue has a calendar ID", async () => {
    await db.update(s.venues).set({ googleCalendarId: "lakeside@group.calendar.google.com" }).where(eq(s.venues.id, lk.id));
    const lkWorkshops = (await db.select().from(s.services).where(eq(s.services.venueId, lk.id))).find((x) => x.kind === "session")!;
    const b = await insertBooking({ venueId: lk.id, serviceId: lkWorkshops.id, roomId: lkWorkshops.roomId });
    process.env.BAYPOOK_MODE = "live";
    const r = await syncBookingToCalendar(db, b.id, "create");
    expect(r!.status).toBe("demo");
    const payload = r!.payload as Record<string, unknown>;
    expect(payload.calendarId).toBe("lakeside@group.calendar.google.com");
    expect(payload.fallback).toBe(true);
  });
});

describe("listCalendarLog", () => {
  it("scopes by venue and limits", async () => {
    expect(await listCalendarLog(db, { venueIds: [] })).toHaveLength(0);
    const lkRows = await listCalendarLog(db, { venueIds: [lk.id] });
    expect(lkRows.length).toBeGreaterThan(0);
    expect(lkRows.every((r) => r.venueId === lk.id)).toBe(true);
    expect(await listCalendarLog(db, { limit: 1 })).toHaveLength(1);
  });
});

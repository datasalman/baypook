process.env.BAYPOOK_MODE = "demo";

import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { getVenueBySlug } from "@/server/org";
import { getServiceBySlug } from "@/server/catalogue";
import { listAudit } from "@/server/audit";
import { listCalendarLog } from "@/server/calendar";
import { listJobRuns } from "@/server/jobs";
import { listOutbox } from "@/server/notifications";

const DAY = 24 * 60 * 60_000;
const T0 = new Date("2026-10-01T10:00:00Z");

let db: Db;
let bookingId: string;

beforeAll(async () => {
  db = await createTestDb({ seed: true });
  const venue = (await getVenueBySlug(db, "south-woodford"))!;
  const svc = (await getServiceBySlug(db, venue.id, "classic-workshops"))!;
  const [org] = await db.select().from(s.organisations).limit(1);
  const [cust] = await db
    .insert(s.customers)
    .values({ organisationId: org.id, firstName: "Amina", lastName: "Khan", email: "amina@example.com" })
    .returning();
  const [b] = await db
    .insert(s.bookings)
    .values({
      reference: "BP-FILT1",
      token: "token-filter-1",
      venueId: venue.id,
      serviceId: svc.id,
      roomId: svc.roomId,
      customerId: cust.id,
      startsAt: new Date(T0.getTime() + 5 * DAY),
      endsAt: new Date(T0.getTime() + 5 * DAY + 3_600_000),
      status: "confirmed",
      lines: [],
      places: 1,
      subtotalPence: 1700,
      totalPence: 1700,
      paidPence: 1700,
      source: "online",
      paymentMethod: "online_card",
      paymentStatus: "paid",
    })
    .returning();
  bookingId = b.id;

  await db.insert(s.calendarLog).values([
    { bookingId, venueId: venue.id, provider: "demo", action: "create", status: "demo", providerEventId: "evt-alpha", createdAt: T0 },
    { bookingId: null, venueId: venue.id, provider: "demo", action: "update", status: "demo", providerEventId: "evt-beta", createdAt: new Date(T0.getTime() + 2 * DAY) },
  ]);
  await db.insert(s.notifications).values([
    { venueId: venue.id, template: "confirmation", toAddress: "a@example.com", subject: "Booked", status: "demo", bodyHtml: "<p></p>", createdAt: T0 },
    { venueId: venue.id, template: "reminder", toAddress: "b@example.com", subject: "Soon", status: "failed", bodyHtml: "<p></p>", createdAt: T0 },
  ]);
  await db.insert(s.auditLog).values([
    { actor: "system", action: "booking.cancel", entityType: "booking", entityId: bookingId, createdAt: T0 },
    { actor: "system", action: "service.update", entityType: "service", createdAt: T0 },
  ]);
  await db.insert(s.jobRuns).values([
    { job: "expire-holds", triggeredBy: "test", status: "ok", startedAt: T0 },
    { job: "reminders", triggeredBy: "test", status: "ok", startedAt: new Date(T0.getTime() + 3 * DAY) },
  ]);
});

describe("admin list filters", () => {
  it("listCalendarLog finds rows by booking reference, event id and date range", async () => {
    const byRef = await listCalendarLog(db, { search: "bp-filt1" });
    expect(byRef.map((r) => r.providerEventId)).toEqual(["evt-alpha"]);
    const byEvent = await listCalendarLog(db, { search: "BETA" });
    expect(byEvent.map((r) => r.providerEventId)).toEqual(["evt-beta"]);
    const range = await listCalendarLog(db, { from: new Date(T0.getTime() + DAY), to: new Date(T0.getTime() + 3 * DAY) });
    expect(range.map((r) => r.providerEventId)).toEqual(["evt-beta"]);
    expect((await listCalendarLog(db, {})).length).toBeGreaterThanOrEqual(2);
  });

  it("listOutbox filters by template and status in the query", async () => {
    const reminders = await listOutbox(db, { template: "reminder" });
    expect(reminders.every((r) => r.template === "reminder")).toBe(true);
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    const failed = await listOutbox(db, { status: "failed", limit: 1 });
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe("failed");
  });

  it("listAudit filters by entity type in the query", async () => {
    const rows = await listAudit(db, { entityType: "service", limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("service");
  });

  it("listJobRuns filters by job and start date", async () => {
    const day = await listJobRuns(db, { from: new Date(T0.getTime() + 2 * DAY), to: new Date(T0.getTime() + 4 * DAY) });
    expect(day.map((r) => r.job)).toEqual(["reminders"]);
    const holds = await listJobRuns(db, { job: "expire-holds", to: new Date(T0.getTime() + DAY) });
    expect(holds.map((r) => r.job)).toEqual(["expire-holds"]);
  });
});

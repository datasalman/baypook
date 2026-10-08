process.env.BAYPOOK_MODE = "demo";

import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { zonedDateTime } from "@/core/time";
import { loadSchedule, loadSessionDetail, mondayOf, shortName } from "@/app/(admin)/admin/_lib/schedule";

const TZ = "Europe/London";
let db: Db;
let sw: s.Venue;

beforeAll(async () => {
  db = await createTestDb({ seed: true });
  [sw] = await db.select().from(s.venues).where(eq(s.venues.slug, "south-woodford"));
});

async function addBooking(input: { serviceSlug: string; start: string; minutes: number; places: number; sessionId?: string | null; status?: s.Booking["status"]; first: string; last: string; child?: string }) {
  const [svc] = await db.select().from(s.services).where(and(eq(s.services.venueId, sw.id), eq(s.services.slug, input.serviceSlug)));
  const [org] = await db.select().from(s.organisations);
  const [cust] = await db
    .insert(s.customers)
    .values({ organisationId: org.id, firstName: input.first, lastName: input.last, email: `${input.first}@example.com`, phone: "07700 900123" })
    .returning();
  const startsAt = zonedDateTime("2026-10-24", input.start, TZ);
  const [b] = await db
    .insert(s.bookings)
    .values({
      reference: `BP-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      venueId: sw.id,
      serviceId: svc.id,
      roomId: svc.roomId,
      sessionId: input.sessionId ?? null,
      customerId: cust.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + input.minutes * 60_000),
      status: input.status ?? "confirmed",
      places: input.places,
      source: "manual",
      paymentMethod: "cash",
      paymentStatus: "paid",
      token: Math.random().toString(36),
      birthdayChildFirstName: input.child ?? null,
      birthdayChildAge: input.child ? 7 : null,
    })
    .returning();
  return b;
}

describe("admin schedule loaders", () => {
  it("shows sessions with places taken, parties and blocks for a day", async () => {
    const first = await loadSchedule(db, { venueIds: [sw.id], from: "2026-10-24", to: "2026-10-24", tz: TZ });
    const ten = first.find((i) => i.kind === "session" && i.startsAt.getTime() === zonedDateTime("2026-10-24", "10:00", TZ).getTime());
    expect(ten?.kind).toBe("session");

    await addBooking({ serviceSlug: "classic-workshops", start: "10:00", minutes: 60, places: 3, sessionId: ten!.id, first: "Amira", last: "Khan" });
    await addBooking({ serviceSlug: "classic-workshops", start: "10:00", minutes: 60, places: 2, sessionId: ten!.id, first: "Ben", last: "Taylor", status: "cancelled" });
    await addBooking({ serviceSlug: "slime-party", start: "14:00", minutes: 90, places: 12, first: "Sarah", last: "Jones", child: "Mia" });
    await db.insert(s.blocks).values({
      venueId: sw.id,
      startsAt: zonedDateTime("2026-10-24", "16:00", TZ),
      endsAt: zonedDateTime("2026-10-25", "12:00", TZ),
      reason: "Private hire",
    });

    const items = await loadSchedule(db, { venueIds: [sw.id], from: "2026-10-24", to: "2026-10-25", tz: TZ });
    const session = items.find((i) => i.id === ten!.id);
    expect(session).toMatchObject({ kind: "session", taken: 3, capacity: 10, parents: ["Amira K."] });
    const party = items.find((i) => i.kind === "party");
    expect(party).toMatchObject({ birthdayChildFirstName: "Mia", parentName: "Sarah Jones", places: 12, date: "2026-10-24" });
    const blocks = items.filter((i) => i.kind === "block");
    expect(blocks.map((b) => [b.date, b.kind === "block" && b.allDay])).toEqual([
      ["2026-10-24", false],
      ["2026-10-25", false],
    ]);

    const detail = await loadSessionDetail(db, ten!.id);
    expect(detail?.taken).toBe(3);
    expect(detail?.bookings).toHaveLength(2);
    expect(detail?.venue.id).toBe(sw.id);
    expect(await loadSessionDetail(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("helpers", () => {
    expect(shortName("Amira", "khan")).toBe("Amira K.");
    expect(mondayOf("2026-10-25")).toBe("2026-10-19");
    expect(mondayOf("2026-10-19")).toBe("2026-10-19");
    expect(mondayOf("2026-10-21")).toBe("2026-10-19");
  });
});

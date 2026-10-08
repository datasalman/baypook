process.env.BAYPOOK_MODE = "demo";

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { zonedDateTime } from "@/core/time";
import {
  bookingsCsv,
  csvSafe,
  customersCsv,
  noShows,
  outstanding,
  presetRange,
  refundsInRange,
  takingsByDay,
  takingsCsvRows,
  toCsv,
  upcomingSummary,
} from "@/server/reports";

const TZ = "Europe/London";
let db: Db;
let sw: s.Venue;
let lk: s.Venue;
let ownerId: string;

async function makeBooking(opts: {
  venue: s.Venue;
  ref: string;
  start: Date;
  totalPence: number;
  status?: s.Booking["status"];
  paymentStatus?: s.Booking["paymentStatus"];
  paidPence?: number;
  email?: string;
}): Promise<s.Booking> {
  const [org] = await db.select().from(s.organisations).limit(1);
  const [svc] = await db.select().from(s.services).where(eq(s.services.venueId, opts.venue.id)).limit(1);
  const [cust] = await db
    .insert(s.customers)
    .values({ organisationId: org.id, firstName: "Ann", lastName: `Smith, "${opts.ref}"`, email: opts.email ?? `${opts.ref}@example.com`, phone: "+44 7000 000000" })
    .returning();
  const [b] = await db
    .insert(s.bookings)
    .values({
      reference: opts.ref,
      venueId: opts.venue.id,
      serviceId: svc.id,
      roomId: svc.roomId,
      customerId: cust.id,
      startsAt: opts.start,
      endsAt: new Date(opts.start.getTime() + 3600_000),
      status: opts.status ?? "confirmed",
      lines: [{ optionId: "x", name: "Slime Workshop", qty: 2, unitPence: 1700, totalPence: 3400 }],
      places: 2,
      subtotalPence: opts.totalPence,
      totalPence: opts.totalPence,
      paidPence: opts.paidPence ?? opts.totalPence,
      source: "online",
      paymentMethod: "online_card",
      paymentStatus: opts.paymentStatus ?? "paid",
      token: `tok-${opts.ref}`,
    })
    .returning();
  return b;
}

async function pay(b: s.Booking, amount: number, method: s.Payment["method"], at: Date, status: s.Payment["status"] = "succeeded") {
  const [p] = await db
    .insert(s.payments)
    .values({ bookingId: b.id, venueId: b.venueId, provider: method === "online_card" ? "demo" : "manual", amountPence: amount, status, method, createdAt: at })
    .returning();
  return p;
}

beforeAll(async () => {
  db = await createTestDb({ seed: true });
  const venues = await db.select().from(s.venues);
  sw = venues.find((v) => v.slug === "south-woodford")!;
  lk = venues.find((v) => v.slug === "lakeside")!;
  const [owner] = await db.select().from(s.users).where(eq(s.users.email, "owner@demo.baypook"));
  ownerId = owner.id;

  // Day 1 (Mon 12 Oct 2026): SW online £34 + cash £17; LK card machine £10.
  const d1 = zonedDateTime("2026-10-12", "11:00", TZ);
  const b1 = await makeBooking({ venue: sw, ref: "BP-AAA01", start: d1, totalPence: 3400 });
  const p1 = await pay(b1, 3400, "online_card", d1, "partially_refunded");
  const b2 = await makeBooking({ venue: sw, ref: "BP-AAA02", start: d1, totalPence: 1700 });
  await pay(b2, 1700, "cash", d1);
  const b3 = await makeBooking({ venue: lk, ref: "BP-AAA03", start: d1, totalPence: 1000 });
  await pay(b3, 1000, "card_machine", d1);
  // A failed payment and an imported one never count.
  await pay(b3, 9999, "online_card", d1, "failed");
  await pay(b3, 5000, "imported", d1);

  // Day 2 (Tue 13 Oct, 23:30 local = 22:30 UTC, still the 13th locally): LK online £20; refund £17 on SW.
  const d2 = zonedDateTime("2026-10-13", "23:30", TZ);
  const b4 = await makeBooking({ venue: lk, ref: "BP-AAA04", start: d2, totalPence: 2000, status: "no_show" });
  await pay(b4, 2000, "online_card", d2);
  await db
    .insert(s.refunds)
    .values({ paymentId: p1.id, bookingId: b1.id, amountPence: 1700, reason: "Poorly child", status: "succeeded", createdBy: ownerId, createdAt: d2 });
  // A failed refund is listed but not subtracted.
  await db.insert(s.refunds).values({ paymentId: p1.id, bookingId: b1.id, amountPence: 500, reason: "Typo", status: "failed", createdAt: d2 });

  // Owed booking (pay in store), and a cancelled owed one that must not show.
  await makeBooking({ venue: sw, ref: "BP-OWED1", start: zonedDateTime("2026-10-20", "10:00", TZ), totalPence: 1700, paidPence: 0, paymentStatus: "owed" });
  await makeBooking({ venue: sw, ref: "BP-OWED2", start: zonedDateTime("2026-10-20", "11:00", TZ), totalPence: 1700, paidPence: 0, paymentStatus: "owed", status: "cancelled" });
});

describe("takingsByDay", () => {
  it("sums online, in store and refunds per local day per venue", async () => {
    const r = await takingsByDay(db, { venueIds: [sw.id, lk.id], from: "2026-10-12", to: "2026-10-13", tz: TZ });
    const key = (d: string, v: string) => r.rows.find((x) => x.date === d && x.venueId === v);

    const swDay1 = key("2026-10-12", sw.id)!;
    expect(swDay1.onlinePence).toBe(3400);
    expect(swDay1.cashPence).toBe(1700);
    expect(swDay1.inStorePence).toBe(1700);
    expect(swDay1.netPence).toBe(5100);

    const lkDay1 = key("2026-10-12", lk.id)!;
    expect(lkDay1.cardMachinePence).toBe(1000);
    expect(lkDay1.onlinePence).toBe(0);
    expect(lkDay1.netPence).toBe(1000);

    const lkDay2 = key("2026-10-13", lk.id)!;
    expect(lkDay2.onlinePence).toBe(2000);

    const swDay2 = key("2026-10-13", sw.id)!;
    expect(swDay2.refundsPence).toBe(1700);
    expect(swDay2.netPence).toBe(-1700);

    expect(r.rows.map((x) => x.date)).toEqual(["2026-10-12", "2026-10-12", "2026-10-13", "2026-10-13"]);
    expect(r.totals).toEqual({
      onlinePence: 5400,
      cashPence: 1700,
      cardMachinePence: 1000,
      inStorePence: 2700,
      refundsPence: 1700,
      netPence: 6400,
    });

    const csv = takingsCsvRows(r);
    expect(csv.at(-1)).toEqual(["Total", "", "54.00", "17.00", "10.00", "27.00", "17.00", "64.00"]);
  });

  it("scopes by venue and by date", async () => {
    const onlyLk = await takingsByDay(db, { venueIds: [lk.id], from: "2026-10-12", to: "2026-10-13", tz: TZ });
    expect(onlyLk.rows.every((x) => x.venueId === lk.id)).toBe(true);
    expect(onlyLk.totals.netPence).toBe(3000);
    const day1 = await takingsByDay(db, { venueIds: [sw.id, lk.id], from: "2026-10-12", to: "2026-10-12", tz: TZ });
    expect(day1.totals.netPence).toBe(6100);
    const none = await takingsByDay(db, { venueIds: [], from: "2026-10-12", to: "2026-10-13", tz: TZ });
    expect(none.rows).toEqual([]);
  });
});

describe("other reports", () => {
  it("lists no-shows, refunds and money owed", async () => {
    const range = { venueIds: [sw.id, lk.id], from: "2026-10-12", to: "2026-10-13", tz: TZ };
    const ns = await noShows(db, range);
    expect(ns.map((b) => b.reference)).toEqual(["BP-AAA04"]);

    const refunds = await refundsInRange(db, range);
    expect(refunds).toHaveLength(2);
    const ok = refunds.find((r) => r.status === "succeeded")!;
    expect(ok.reference).toBe("BP-AAA01");
    expect(ok.byName).toBe("Demo owner");

    const owed = await outstanding(db, { venueIds: [sw.id] });
    expect(owed.map((b) => b.reference)).toEqual(["BP-OWED1"]);
    expect(owed[0].owedPence).toBe(1700);
    expect(await outstanding(db, { venueIds: [lk.id] })).toEqual([]);
  });

  it("summarises upcoming confirmed bookings per venue and service", async () => {
    const up = await upcomingSummary(db, { venueIds: [sw.id, lk.id], now: zonedDateTime("2026-10-12", "00:00", TZ) });
    const swUp = up.find((v) => v.venueId === sw.id)!;
    // BP-AAA01, BP-AAA02 and BP-OWED1 are confirmed; the cancelled one is not.
    expect(swUp.count).toBe(3);
    expect(swUp.valuePence).toBe(3400 + 1700 + 1700);
    expect(swUp.services[0].count).toBe(3);
    const lkUp = up.find((v) => v.venueId === lk.id)!;
    expect(lkUp.count).toBe(1); // BP-AAA04 is a no-show
  });

  it("exports bookings and customers with a header row", async () => {
    const rows = await bookingsCsv(db, { venueIds: [sw.id], tz: TZ, from: "2026-10-12", to: "2026-10-12", includeContact: true });
    expect(rows[0].slice(6, 9)).toEqual(["Customer name", "Email", "Phone"]);
    expect(rows[0][0]).toBe("Reference");
    expect(rows.slice(1).map((r) => r[0])).toEqual(["BP-AAA01", "BP-AAA02"]);
    expect(rows[1][3]).toBe("2026-10-12 11:00");
    expect(rows[1][10]).toBe("2 x Slime Workshop");
    expect(rows[1][11]).toBe("34.00");

    const all = await bookingsCsv(db, { venueIds: [sw.id, lk.id], tz: TZ, includeContact: true });
    expect(all.length).toBe(1 + 6);

    // Staff: no email or phone columns.
    const staff = await bookingsCsv(db, { venueIds: [sw.id], tz: TZ, from: "2026-10-12", to: "2026-10-12", includeContact: false });
    expect(staff[0]).not.toContain("Email");
    expect(staff[0]).not.toContain("Phone");
    expect(staff[0].length).toBe(rows[0].length - 2);
    expect(staff[1].join(",")).not.toMatch(/@example\.com|7000 000000/);

    const cust = await customersCsv(db, { venueIds: [lk.id], tz: TZ });
    expect(cust.length).toBe(1 + 2);
    expect(cust[1][3]).toBe("1");
    const everyone = await customersCsv(db, { venueIds: [], tz: TZ, allCustomers: true });
    expect(everyone.length).toBeGreaterThanOrEqual(1 + 6);
  });
});

describe("toCsv", () => {
  it("quotes commas, quotes and line breaks per RFC 4180", () => {
    const out = toCsv([
      ["a", "b,c", 'say "hi"'],
      ["line\nbreak", "plain", ""],
    ]);
    expect(out).toBe('a,"b,c","say ""hi"""\r\n"line\nbreak",plain,\r\n');
  });

  it("neutralises formulas but leaves numbers alone", () => {
    expect(csvSafe("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvSafe("+44 7000 000000")).toBe("'+44 7000 000000");
    expect(csvSafe("-17.00")).toBe("-17.00");
    expect(toCsv([["@x,y"]])).toBe("\"'@x,y\"\r\n");
  });
});

describe("presetRange", () => {
  it("works out today, this week, this month and last month", () => {
    expect(presetRange("today", "2026-10-08")).toEqual({ from: "2026-10-08", to: "2026-10-08" });
    expect(presetRange("week", "2026-10-08")).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    expect(presetRange("week", "2026-10-11")).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    expect(presetRange("month", "2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("lastmonth", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
});

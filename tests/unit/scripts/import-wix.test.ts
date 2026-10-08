process.env.BAYPOOK_MODE = "demo";

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { loadUser, type CurrentUser } from "@/server/auth";
import { listVenues } from "@/server/org";
import { listServicesForVenue } from "@/server/catalogue";
import {
  formatOutcomes,
  importWix,
  notesHaveWixRef,
  parseAddOns,
  parseBirthdayChild,
  parseCsv,
  parsePounds,
  parseStart,
  planRow,
  readWixCsv,
  slugify,
  type CatalogueVenue,
} from "../../../scripts/import-wix";

const SAMPLE = fs.readFileSync(path.resolve(__dirname, "../../../docs/wix-import-sample.csv"), "utf8");
const NOW = new Date("2026-10-20T09:00:00Z");

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded commas and newlines, CRLF and a BOM", () => {
    const text = '﻿a,b,c\r\n1,"two, too","say ""hi"""\r\n\r\n3,"multi\nline",\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["1", "two, too", 'say "hi"'],
      ["3", "multi\nline", ""],
    ]);
  });

  it("keeps a last line without a newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("value parsers", () => {
  it("reads pounds into pence", () => {
    expect(parsePounds("34")).toBe(3400);
    expect(parsePounds("44.5")).toBe(4450);
    expect(parsePounds("£1,234.05")).toBe(123405);
    expect(parsePounds("")).toBeNull();
    expect(parsePounds("abc")).toBeNaN();
  });

  it("reads London local times and ISO instants", () => {
    // BST in October, GMT in November.
    expect(parseStart("2026-10-24 14:00")?.toISOString()).toBe("2026-10-24T13:00:00.000Z");
    expect(parseStart("2026-11-07 9:00")?.toISOString()).toBe("2026-11-07T09:00:00.000Z");
    expect(parseStart("24/10/2026 14:00")?.toISOString()).toBe("2026-10-24T13:00:00.000Z");
    expect(parseStart("2026-10-24T14:00")?.toISOString()).toBe("2026-10-24T13:00:00.000Z");
    expect(parseStart("2026-10-24T14:00:00+01:00")?.toISOString()).toBe("2026-10-24T13:00:00.000Z");
    expect(parseStart("2026-11-14T10:00:00Z")?.toISOString()).toBe("2026-11-14T10:00:00.000Z");
    expect(parseStart("next Tuesday")).toBeNull();
    expect(parseStart("2026-13-01 10:00")).toBeNull();
  });

  it("reads the birthday child, extras and slugs", () => {
    expect(parseBirthdayChild("Zara, 7")).toEqual({ firstName: "Zara", age: 7 });
    expect(parseBirthdayChild("Zara (10)")).toEqual({ firstName: "Zara", age: 10 });
    expect(parseBirthdayChild("Zara")).toEqual({ firstName: "Zara", age: null });
    expect(parseBirthdayChild("  ")).toBeNull();
    expect(parseAddOns("Food time; Extra child x2")).toEqual([
      { name: "Food time", qty: 1 },
      { name: "Extra child", qty: 2 },
    ]);
    expect(parseAddOns("")).toEqual([]);
    expect(slugify("Decoden Craft Workshop")).toBe("decoden-craft-workshop");
  });

  it("matches a Wix reference exactly in the notes", () => {
    expect(notesHaveWixRef("Wix ref WX-1\nNut allergy", "WX-1")).toBe(true);
    expect(notesHaveWixRef("Wix ref WX-12", "WX-1")).toBe(false);
    expect(notesHaveWixRef("wix ref wx-1", "WX-1")).toBe(true);
    expect(notesHaveWixRef(null, "WX-1")).toBe(false);
  });
});

describe("readWixCsv", () => {
  it("reads the sample file", () => {
    const { rows, problems } = readWixCsv(SAMPLE);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      line: 2,
      reference: "WX-10231",
      venue: "south-woodford",
      places: 3,
      placesByOption: { "slime-workshop": 2, "decoden-craft-workshop": 1 },
      paidTotalPence: 4400,
    });
    expect(rows[1]).toMatchObject({
      birthdayChild: { firstName: "Zara", age: 7 },
      addOns: [{ name: "Food time", qty: 1 }],
      notes: "One child has a nut allergy, please no snacks",
    });
  });

  it("accepts any header case and reports bad rows", () => {
    const { rows, problems } = readWixCsv(
      "Reference,VENUE,Service,Start,First Name,Places,Paid_Total\nA1,lakeside,Slime Party,2026-11-01 10:00,Amy,x,10\nA2,lakeside,Slime Party,2026-11-01 10:00,Amy,10,ten\n,lakeside,x,y,z,1,1\n",
    );
    expect(rows).toHaveLength(0);
    expect(problems.map((p) => p.line)).toEqual([2, 3, 4]);
    expect(readWixCsv("reference,venue\nA,b\n").problems[0].message).toMatch(/Missing column/);
  });
});

describe("planRow", () => {
  let catalogue: CatalogueVenue[];
  beforeAll(async () => {
    const db = await createTestDb({ seed: true });
    catalogue = [];
    for (const venue of await listVenues(db)) catalogue.push({ venue, services: await listServicesForVenue(db, venue.id) });
  });
  const row = (over: Partial<ReturnType<typeof readWixCsv>["rows"][number]>) => ({ ...readWixCsv(SAMPLE).rows[0], ...over });

  it("splits workshop places across options, or puts them all on the first", () => {
    const split = planRow(row({}), catalogue);
    expect(split.lines.map((l) => l.qty)).toEqual([2, 1]);
    expect(split.notes).toBe("Wix ref WX-10231");
    const plain = planRow(row({ placesByOption: {}, places: 4 }), catalogue);
    expect(plain.lines).toHaveLength(1);
    expect(plain.lines[0].qty).toBe(4);
    expect(() => planRow(row({ places: 5 }), catalogue)).toThrow(/add up to 3/);
  });

  it("turns a party's children into extra children and finds extras by name", () => {
    const party = planRow(readWixCsv(SAMPLE).rows[1], catalogue);
    expect(party.service.kind).toBe("slot");
    expect(party.lines).toHaveLength(1);
    const names = party.addOns.map((a) => [party.service.addOns.find((x) => x.id === a.addOnId)?.name, a.qty]);
    expect(names).toEqual(
      expect.arrayContaining([
        ["Food time", 1],
        ["Extra child", 2],
      ]),
    );
    expect(party.birthdayChild).toEqual({ firstName: "Zara", age: 7 });
  });

  it("explains what it cannot match", () => {
    expect(() => planRow(row({ venue: "Croydon" }), catalogue)).toThrow(/No venue/);
    expect(() => planRow(row({ service: "Pottery" }), catalogue)).toThrow(/No service/);
    expect(() => planRow(row({ start: "soon" }), catalogue)).toThrow(/Cannot read the start/);
    expect(planRow(row({ email: "" }), catalogue).customer.email).toBe("no-email@south-woodford.local");
  });
});

describe("importWix", () => {
  let db: Db;
  let owner: CurrentUser;
  beforeAll(async () => {
    db = await createTestDb({ seed: true });
    const [row] = await db.select().from(s.users).where(eq(s.users.isOwner, true));
    owner = (await loadUser(db, row.id))!;
  });

  it("checks without saving on a dry run", async () => {
    const outcomes = await importWix(db, SAMPLE, { user: owner, dryRun: true, now: NOW });
    expect(outcomes.map((o) => o.result)).toEqual(["would create", "would create", "would create"]);
    expect(await db.select().from(s.bookings)).toHaveLength(0);
  });

  it("creates confirmed, imported bookings with their payments, sends no email and mirrors to the calendar", async () => {
    const outcomes = await importWix(db, SAMPLE, { user: owner, now: NOW });
    expect(outcomes.map((o) => o.result)).toEqual(["created", "created", "created"]);
    expect(formatOutcomes(outcomes)).toMatch(/3 created, 0 would create, 0 skipped, 0 failed/);

    const bookings = await db.select().from(s.bookings);
    expect(bookings).toHaveLength(3);
    for (const b of bookings) {
      expect(b).toMatchObject({ status: "confirmed", source: "import", paymentMethod: "imported", paymentStatus: "paid" });
      expect(b.notes).toMatch(/^Wix ref WX-1023\d/);
    }
    const workshop = bookings.find((b) => b.notes?.startsWith("Wix ref WX-10231"))!;
    expect(workshop).toMatchObject({ places: 3, totalPence: 4400, paidPence: 4400 });
    expect(workshop.startsAt.toISOString()).toBe("2026-11-07T14:00:00.000Z");
    const party = bookings.find((b) => b.notes?.startsWith("Wix ref WX-10232"))!;
    expect(party).toMatchObject({ places: 12, totalPence: 28200, birthdayChildFirstName: "Zara", birthdayChildAge: 7 });
    expect(party.notes).toContain("nut allergy");
    expect(party.endsAt.getTime() - party.startsAt.getTime()).toBe(120 * 60_000);

    const payments = await db.select().from(s.payments);
    expect(payments).toHaveLength(3);
    for (const p of payments) expect(p).toMatchObject({ provider: "import", method: "imported", status: "succeeded" });

    const emails = await db.select().from(s.notifications);
    expect(emails).toHaveLength(0);
    const calendar = await db.select().from(s.calendarLog).where(eq(s.calendarLog.action, "create"));
    expect(calendar).toHaveLength(3);
    const audits = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "booking.import"));
    expect(audits).toHaveLength(3);
  });

  it("skips rows it has already imported, so it can be run again", async () => {
    const again = await importWix(db, SAMPLE, { user: owner, now: NOW });
    expect(again.map((o) => o.result)).toEqual(["skipped", "skipped", "skipped"]);
    expect(again[0].message).toMatch(/Already imported as BP-/);
    expect(await db.select().from(s.bookings)).toHaveLength(3);
  });

  it("fails rows that clash, have no session, are in the past or do not match, and carries on", async () => {
    const csv = [
      "reference,venue,service,start,first_name,last_name,email,phone,places,paid_total",
      // The party room at South Woodford is taken 11:00 to 13:00 on 8 November by WX-10232.
      "WX-2,south-woodford,Decoden Craft Party,2026-11-08 12:00,Dan,Lee,dan@example.com,,8,250",
      "WX-3,south-woodford,Classic Workshops,2026-11-07 14:30,Eve,Ray,eve@example.com,,1,17",
      "WX-4,south-woodford,Classic Workshops,2026-10-01 14:00,Fay,Ng,fay@example.com,,1,17",
      "WX-5,south-woodford,Pottery,2026-11-07 14:00,Gus,Po,gus@example.com,,1,17",
      "WX-6,south-woodford,Classic Workshops,2026-11-07 15:00,Hal,,,,2,30",
      "WX-6,south-woodford,Classic Workshops,2026-11-07 15:00,Hal,,,,2,30",
    ].join("\n");
    const outcomes = await importWix(db, csv, { user: owner, now: NOW });
    expect(outcomes.map((o) => [o.reference, o.result])).toEqual([
      ["WX-2", "failed"],
      ["WX-3", "failed"],
      ["WX-4", "failed"],
      ["WX-5", "failed"],
      ["WX-6", "created"],
      ["WX-6", "skipped"],
    ]);
    expect(outcomes[1].message).toMatch(/no Classic Workshops session at that time/);
    expect(outcomes[2].message).toMatch(/already started/);
    expect(outcomes[4].message).toMatch(/Paid on Wix £30.00; BayPook's price today £34.00/);

    const hal = (await db.select().from(s.bookings)).find((b) => b.notes?.startsWith("Wix ref WX-6"))!;
    expect(hal).toMatchObject({ paidPence: 3000, totalPence: 3400, paymentStatus: "owed" });
    const [customer] = await db.select().from(s.customers).where(eq(s.customers.id, hal.customerId));
    expect(customer.email).toBe("no-email@south-woodford.local");
  });
});

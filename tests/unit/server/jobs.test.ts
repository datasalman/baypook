process.env.BAYPOOK_MODE = "demo";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { getVenueBySlug } from "@/server/org";
import { getServiceBySlug, type ServiceWithCatalogue } from "@/server/catalogue";
import { runJob } from "@/server/jobs";
import { isUndeliverableEmail, remindersJob } from "@/server/jobs-reminders";
import { anonymisedEmail, retentionJob } from "@/server/jobs-retention";

const NOW = new Date("2026-11-10T10:00:00Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let db: Db;
let venue: s.Venue;
let workshops: ServiceWithCatalogue;
let orgId: string;
let seq = 0;

async function customer(email = `parent${++seq}@example.com`, createdAt = new Date(NOW.getTime() - 900 * DAY)): Promise<s.Customer> {
  const [row] = await db
    .insert(s.customers)
    .values({ organisationId: orgId, firstName: "Amina", lastName: "Khan", email, phone: "07700 900123", notes: "Prefers WhatsApp", createdAt })
    .returning();
  return row;
}

async function booking(opts: {
  startsAt: Date;
  createdAt?: Date;
  status?: s.Booking["status"];
  customerId?: string;
  email?: string;
}): Promise<s.Booking> {
  const customerId = opts.customerId ?? (await customer(opts.email)).id;
  const n = ++seq;
  const [row] = await db
    .insert(s.bookings)
    .values({
      reference: `BP-T${String(n).padStart(4, "0")}`,
      token: `token-${n}`,
      venueId: venue.id,
      serviceId: workshops.id,
      roomId: workshops.roomId,
      customerId,
      startsAt: opts.startsAt,
      endsAt: new Date(opts.startsAt.getTime() + HOUR),
      status: opts.status ?? "confirmed",
      lines: [{ optionId: workshops.options[0].id, name: workshops.options[0].name, qty: 2, unitPence: 1700, totalPence: 3400 }],
      places: 2,
      subtotalPence: 3400,
      totalPence: 3400,
      paidPence: 3400,
      source: "online",
      paymentMethod: "online_card",
      paymentStatus: "paid",
      notes: "Nut allergy",
      customerMessage: "It's Zara's first time",
      birthdayChildFirstName: "Zara",
      createdAt: opts.createdAt ?? new Date(opts.startsAt.getTime() - 10 * DAY),
    })
    .returning();
  return row;
}

async function reload(id: string): Promise<s.Booking> {
  const [row] = await db.select().from(s.bookings).where(eq(s.bookings.id, id));
  return row;
}

async function reminderEmails(bookingId: string): Promise<s.Notification[]> {
  return db
    .select()
    .from(s.notifications)
    .where(and(eq(s.notifications.bookingId, bookingId), eq(s.notifications.template, "reminder")));
}

beforeAll(async () => {
  // One seeded database is shared: each test makes its own bookings and checks only those.
  db = await createTestDb({ seed: true });
  venue = (await getVenueBySlug(db, "south-woodford"))!;
  workshops = (await getServiceBySlug(db, venue.id, "classic-workshops"))!;
  const [org] = await db.select().from(s.organisations);
  orgId = org.id;
});

describe("isUndeliverableEmail", () => {
  it("rejects blanks, placeholders and anonymised addresses", () => {
    expect(isUndeliverableEmail("")).toBe(true);
    expect(isUndeliverableEmail(null)).toBe(true);
    expect(isUndeliverableEmail("no-email@south-woodford.local")).toBe(true);
    expect(isUndeliverableEmail("anon-1234abcd@anonymised.local")).toBe(true);
    expect(isUndeliverableEmail("amina@example.com")).toBe(false);
  });
});

describe("remindersJob", () => {
  beforeEach(async () => {
    // Clear earlier tests' bookings out of the reminder window.
    await db.update(s.bookings).set({ reminderSentAt: NOW });
  });

  it("sends one reminder to a confirmed booking inside the window, and never twice", async () => {
    const b = await booking({ startsAt: new Date(NOW.getTime() + 20 * HOUR) });
    const first = await remindersJob(db, NOW);
    expect(first).toMatchObject({ due: 1, sent: 1, skipped: 0, failed: 0 });
    const emails = await reminderEmails(b.id);
    expect(emails).toHaveLength(1);
    expect(emails[0].status).toBe("demo");
    expect(emails[0].toAddress).toMatch(/@example\.com$/);
    expect(emails[0].attachments[0]?.filename).toMatch(/\.ics$/);
    expect((await reload(b.id)).reminderSentAt?.toISOString()).toBe(NOW.toISOString());

    const second = await remindersJob(db, new Date(NOW.getTime() + HOUR));
    expect(second).toMatchObject({ due: 0, sent: 0 });
    expect(await reminderEmails(b.id)).toHaveLength(1);
  });

  it("leaves bookings outside the window, past, cancelled or pending alone", async () => {
    const later = await booking({ startsAt: new Date(NOW.getTime() + 30 * HOUR) });
    const past = await booking({ startsAt: new Date(NOW.getTime() - HOUR) });
    const cancelled = await booking({ startsAt: new Date(NOW.getTime() + 5 * HOUR), status: "cancelled" });
    const pending = await booking({ startsAt: new Date(NOW.getTime() + 5 * HOUR), status: "pending" });
    const res = await remindersJob(db, NOW);
    expect(res).toMatchObject({ due: 0, sent: 0 });
    for (const b of [later, past, cancelled, pending]) {
      expect(await reminderEmails(b.id)).toHaveLength(0);
      expect((await reload(b.id)).reminderSentAt).toBeNull();
    }

    // The later one comes into the window six hours on.
    const after = await remindersJob(db, new Date(NOW.getTime() + 7 * HOUR));
    expect(after).toMatchObject({ due: 1, sent: 1 });
    expect(await reminderEmails(later.id)).toHaveLength(1);
  });

  it("skips last-minute bookings and customers without a real address", async () => {
    const start = new Date(NOW.getTime() + 3 * HOUR);
    const lastMinute = await booking({ startsAt: start, createdAt: new Date(start.getTime() - 90 * 60_000) });
    const walkIn = await booking({ startsAt: start, email: "no-email@south-woodford.local" });
    const res = await remindersJob(db, NOW);
    expect(res).toMatchObject({ due: 2, sent: 0, skipped: 2 });
    expect(await reminderEmails(lastMinute.id)).toHaveLength(0);
    expect(await reminderEmails(walkIn.id)).toHaveLength(0);
  });

  it("follows the organisation's reminder lead time", async () => {
    await db.update(s.organisations).set({ reminderHoursBefore: 48 });
    try {
      const b = await booking({ startsAt: new Date(NOW.getTime() + 40 * HOUR) });
      const res = await remindersJob(db, NOW);
      expect(res.sent).toBe(1);
      expect(await reminderEmails(b.id)).toHaveLength(1);
    } finally {
      await db.update(s.organisations).set({ reminderHoursBefore: 24 });
    }
  });

  it("is recorded as a 'reminders' job run", async () => {
    await booking({ startsAt: new Date(NOW.getTime() + 2 * DAY - HOUR) });
    const run = await runJob(db, "reminders", "test", () => remindersJob(db, new Date(NOW.getTime() + DAY)));
    expect(run.job).toBe("reminders");
    expect(run.status).toBe("ok");
    expect(run.summary).toMatchObject({ sent: 1 });
  });
});

describe("retentionJob", () => {
  // Retention is 24 months by default: the cutoff for NOW is 2024-11-10.
  const old = new Date("2024-06-01T10:00:00Z");
  const recent = new Date("2026-09-01T10:00:00Z");

  it("anonymises old bookings and customers with nothing newer, and keeps the rest", async () => {
    const gone = await customer("gone@example.com");
    const goneBooking = await booking({ startsAt: old, customerId: gone.id });
    const regular = await customer("regular@example.com");
    const regularOld = await booking({ startsAt: old, customerId: regular.id });
    const regularNew = await booking({ startsAt: recent, customerId: regular.id });
    const neverBooked = await customer("never@example.com");
    const newcomer = await customer("new@example.com", new Date(NOW.getTime() - DAY));

    const oldMail = await db
      .insert(s.notifications)
      .values({ bookingId: goneBooking.id, template: "confirmation", toAddress: gone.email, subject: "Booked", status: "demo", bodyHtml: "<p>Amina</p>", createdAt: old })
      .returning();
    const newMail = await db
      .insert(s.notifications)
      .values({ bookingId: regularNew.id, template: "confirmation", toAddress: regular.email, subject: "Booked", status: "demo", bodyHtml: "<p>Amina</p>", createdAt: recent })
      .returning();
    await db.insert(s.calendarLog).values({ bookingId: goneBooking.id, provider: "demo", action: "create", status: "demo", payload: { summary: "Amina" }, createdAt: old });
    const veryOldAudit = await db
      .insert(s.auditLog)
      .values({ actor: "system", action: "booking.create", entityType: "booking", createdAt: new Date("2023-06-01T10:00:00Z") })
      .returning();
    const oldAudit = await db
      .insert(s.auditLog)
      .values({ actor: "system", action: "booking.create", entityType: "booking", createdAt: old })
      .returning();

    const res = await retentionJob(db, NOW);
    expect(res.retentionMonths).toBe(24);
    expect(res.cutoff).toBe("2024-11-10T10:00:00.000Z");
    expect(res.auditCutoff).toBe("2023-11-10T10:00:00.000Z");
    expect(res.bookingsAnonymised).toBeGreaterThanOrEqual(2);
    expect(res.notificationsDeleted).toBeGreaterThanOrEqual(1);
    expect(res.calendarLogDeleted).toBeGreaterThanOrEqual(1);
    expect(res.auditDeleted).toBeGreaterThanOrEqual(1);

    for (const id of [goneBooking.id, regularOld.id]) {
      const b = await reload(id);
      expect(b.anonymisedAt?.toISOString()).toBe(NOW.toISOString());
      expect(b.notes).toBeNull();
      expect(b.customerMessage).toBeNull();
      expect(b.birthdayChildFirstName).toBeNull();
      expect(b.totalPence).toBe(3400);
      expect(b.reference).toMatch(/^BP-T/);
    }
    const kept = await reload(regularNew.id);
    expect(kept.anonymisedAt).toBeNull();
    expect(kept.notes).toBe("Nut allergy");

    const customers = new Map((await db.select().from(s.customers)).map((c) => [c.id, c]));
    for (const c of [gone, neverBooked]) {
      const row = customers.get(c.id)!;
      expect(row).toMatchObject({ firstName: "Anonymised", lastName: "", phone: null, notes: null });
      expect(row.email).toBe(anonymisedEmail(c.id));
      expect(row.email).toMatch(/^anon-[0-9a-f]{8}@anonymised\.local$/);
      expect(row.anonymisedAt).not.toBeNull();
    }
    expect(customers.get(regular.id)).toMatchObject({ firstName: "Amina", email: "regular@example.com", anonymisedAt: null });
    expect(customers.get(newcomer.id)).toMatchObject({ firstName: "Amina", anonymisedAt: null });

    const mails = await db.select({ id: s.notifications.id }).from(s.notifications);
    expect(mails.some((m) => m.id === oldMail[0].id)).toBe(false);
    expect(mails.some((m) => m.id === newMail[0].id)).toBe(true);
    const audits = await db.select({ id: s.auditLog.id }).from(s.auditLog);
    expect(audits.some((a) => a.id === veryOldAudit[0].id)).toBe(false);
    expect(audits.some((a) => a.id === oldAudit[0].id)).toBe(true);
  });

  it("does nothing more on a second run", async () => {
    await retentionJob(db, NOW);
    const again = await retentionJob(db, NOW);
    expect(again).toMatchObject({
      bookingsAnonymised: 0,
      customersAnonymised: 0,
      notificationsDeleted: 0,
      calendarLogDeleted: 0,
      auditDeleted: 0,
    });
  });

  it("follows the organisation's retention period and is recorded as a 'retention' run", async () => {
    await db.update(s.organisations).set({ retentionMonths: 1 });
    try {
      const b = await booking({ startsAt: recent });
      const run = await runJob(db, "retention", "test", () => retentionJob(db, NOW));
      expect(run.job).toBe("retention");
      expect(run.status).toBe("ok");
      expect(run.summary).toMatchObject({ retentionMonths: 1 });
      expect((await reload(b.id)).anonymisedAt).not.toBeNull();
    } finally {
      await db.update(s.organisations).set({ retentionMonths: 24 });
    }
  });
});

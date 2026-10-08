process.env.BAYPOOK_MODE = "demo";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { zonedDateTime } from "@/core/time";
import { DemoEmailProvider } from "@/providers/email/demo";
import { DEFAULT_TEMPLATES, type TemplateKey } from "@/providers/email/defaults";
import {
  buildTemplateContext,
  getTemplate,
  listOutbox,
  loadBookingEmailContext,
  previewTemplate,
  renderBookingEmail,
  sendBookingEmail,
  sendRawEmail,
} from "@/server/notifications";

type Fixture = {
  db: Db;
  org: s.Organisation;
  sw: s.Venue;
  lk: s.Venue;
  workshop: s.Booking;
  decoden: s.Booking;
  party: s.Booking;
};

let f: Fixture;

async function setup(): Promise<Fixture> {
  const db = await createTestDb({ seed: true });
  const [org] = await db.select().from(s.organisations);
  const [sw] = await db.select().from(s.venues).where(eq(s.venues.slug, "south-woodford"));
  const [lk] = await db.select().from(s.venues).where(eq(s.venues.slug, "lakeside"));
  const [workshops] = await db
    .select()
    .from(s.services)
    .where(and(eq(s.services.venueId, sw.id), eq(s.services.slug, "classic-workshops")));
  const [party] = await db
    .select()
    .from(s.services)
    .where(and(eq(s.services.venueId, sw.id), eq(s.services.slug, "slime-party")));
  const opts = await db.select().from(s.serviceOptions).where(eq(s.serviceOptions.serviceId, workshops.id));
  const slime = opts.find((o) => o.name === "Slime Workshop")!;
  const deco = opts.find((o) => o.name.startsWith("Decoden"))!;
  const [pkg] = await db.select().from(s.serviceOptions).where(eq(s.serviceOptions.serviceId, party.id));
  const partyAddOns = await db.select().from(s.addOns).where(eq(s.addOns.serviceId, party.id));
  const food = partyAddOns.find((a) => a.kind === "time")!;

  const [customer] = await db
    .insert(s.customers)
    .values({ organisationId: org.id, firstName: "Amina", lastName: "Khan", email: "amina@example.com", phone: "07700 900123" })
    .returning();

  const start = zonedDateTime("2026-10-24", "14:00", "Europe/London");
  const end = zonedDateTime("2026-10-24", "15:00", "Europe/London");
  const common = {
    venueId: sw.id,
    customerId: customer.id,
    status: "confirmed" as const,
    source: "online" as const,
    paymentMethod: "online_card" as const,
    paymentStatus: "paid" as const,
  };

  const [workshop] = await db
    .insert(s.bookings)
    .values({
      ...common,
      reference: "BP-AAAA1",
      token: "tok-1",
      serviceId: workshops.id,
      roomId: workshops.roomId,
      startsAt: start,
      endsAt: end,
      lines: [{ optionId: slime.id, name: slime.name, qty: 2, unitPence: 1700, totalPence: 3400 }],
      places: 2,
      subtotalPence: 3400,
      totalPence: 3400,
      paidPence: 3400,
    })
    .returning();

  const [decoden] = await db
    .insert(s.bookings)
    .values({
      ...common,
      reference: "BP-AAAA2",
      token: "tok-2",
      serviceId: workshops.id,
      roomId: workshops.roomId,
      startsAt: zonedDateTime("2026-10-24", "15:00", "Europe/London"),
      endsAt: zonedDateTime("2026-10-24", "16:00", "Europe/London"),
      lines: [
        { optionId: slime.id, name: slime.name, qty: 1, unitPence: 1700, totalPence: 1700 },
        { optionId: deco.id, name: deco.name, qty: 1, unitPence: 1000, totalPence: 1000 },
      ],
      places: 2,
      subtotalPence: 2700,
      totalPence: 2700,
      paidPence: 2700,
    })
    .returning();

  // Sunday 25 October 2026: the clocks have gone back, London is on GMT.
  const [partyBooking] = await db
    .insert(s.bookings)
    .values({
      ...common,
      reference: "BP-AAAA3",
      token: "tok-3",
      serviceId: party.id,
      roomId: party.roomId,
      startsAt: zonedDateTime("2026-10-25", "11:00", "Europe/London"),
      endsAt: zonedDateTime("2026-10-25", "13:00", "Europe/London"),
      lines: [{ optionId: pkg.id, name: pkg.name, qty: 1, unitPence: 20000, totalPence: 20000, includedChildren: 10 }],
      addOns: [
        { addOnId: food.id, name: food.name, qty: 1, unitPence: 5000, totalPence: 5000, kind: "time", extraMinutes: 30, perChild: false },
      ],
      places: 10,
      subtotalPence: 25000,
      totalPence: 25000,
      paidPence: 25000,
      birthdayChildFirstName: "Maya",
      birthdayChildAge: 8,
    })
    .returning();

  return { db, org, sw, lk, workshop, decoden, party: partyBooking };
}

beforeAll(async () => {
  delete process.env.OWNER_ALERT_EMAIL;
  f = await setup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildTemplateContext", () => {
  it("fills every placeholder key with London times and plain-text lines", async () => {
    const ctx = await loadBookingEmailContext(f.db, f.workshop.id);
    const vars = buildTemplateContext(ctx);
    for (const key of [
      "firstName",
      "reference",
      "serviceName",
      "venueName",
      "dayLong",
      "startTime",
      "endTime",
      "address",
      "parkingLine",
      "whatBooked",
      "total",
      "inStoreNote",
      "birthdayChild",
      "contactLine",
      "organisationName",
      "refundAmount",
      "paymentLine",
      "customerName",
      "customerPhone",
      "customerEmail",
      "adminUrl",
    ]) {
      expect(typeof vars[key]).toBe("string");
    }
    expect(vars.dayLong).toBe("Saturday 24 October 2026");
    expect(vars.startTime).toBe("14:00");
    expect(vars.endTime).toBe("15:00");
    expect(vars.whatBooked).toBe("2 × Slime Workshop  £34.00");
    expect(vars.total).toBe("£34.00");
    expect(vars.paymentLine).toBe("Paid online");
    expect(vars.inStoreNote).toBe("");
    expect(vars.contactLine).toBe("hello@slimedom.com, +44 7498 254704 or WhatsApp https://wa.me/447498254704");
    expect(vars.adminUrl).toMatch(new RegExp(`/admin/bookings/${f.workshop.id}$`));
  });

  it("formats the party package and the time add-on, across the BST change", async () => {
    const vars = buildTemplateContext(await loadBookingEmailContext(f.db, f.party.id), { refundAmountPence: 5000 });
    expect(vars.whatBooked).toBe("Slime Party package (includes 10 children)  £200.00\nFood time (+30 min)  £50.00");
    expect(vars.dayLong).toBe("Sunday 25 October 2026");
    expect(vars.startTime).toBe("11:00");
    expect(vars.endTime).toBe("13:00");
    expect(vars.birthdayChild).toBe("Maya, age 8");
    expect(vars.refundAmount).toBe("£50.00");
  });
});

describe("getTemplate", () => {
  it("reads the organisation's template and falls back to the default", async () => {
    await f.db
      .update(s.emailTemplates)
      .set({ subject: "Edited {{reference}}" })
      .where(and(eq(s.emailTemplates.organisationId, f.org.id), eq(s.emailTemplates.key, "cancellation")));
    expect((await getTemplate(f.db, f.org.id, "cancellation")).subject).toBe("Edited {{reference}}");
    const r = await renderBookingEmail(f.db, { bookingId: f.workshop.id, template: "cancellation" });
    expect(r.subject).toBe("Edited BP-AAAA1");

    await f.db.delete(s.emailTemplates).where(and(eq(s.emailTemplates.organisationId, f.org.id), eq(s.emailTemplates.key, "reminder")));
    const reminder = await getTemplate(f.db, f.org.id, "reminder");
    expect(reminder.subject).toBe(DEFAULT_TEMPLATES.find((t) => t.key === "reminder")!.subject);
  });
});

describe("sendBookingEmail", () => {
  it("sends a confirmation into the Outbox with the .ics attached", async () => {
    const n = await sendBookingEmail(f.db, { bookingId: f.workshop.id, template: "confirmation" });
    expect(n.status).toBe("demo");
    expect(n.error).toBeNull();
    expect(n.sentAt).toBeInstanceOf(Date);
    expect(n.toAddress).toBe("amina@example.com");
    expect(n.bookingId).toBe(f.workshop.id);
    expect(n.venueId).toBe(f.sw.id);
    expect(n.subject).toBe("Your Classic Workshops booking at South Woodford, Saturday 24 October 2026");

    expect(n.attachments).toHaveLength(1);
    const ics = n.attachments[0];
    expect(ics.filename).toBe("booking-BP-AAAA1.ics");
    expect(ics.contentType).toContain("text/calendar");
    expect(ics.content).toContain("METHOD:PUBLISH");
    expect(ics.content).toContain("DTSTART:20261024T130000Z");

    for (const body of [n.bodyHtml, n.bodyText]) {
      expect(body).toContain("53A George Lane, South Woodford, London E18 1LN");
      expect(body).toContain("glittery");
      expect(body).toContain("14:00 to 15:00");
      expect(body).toContain("2 × Slime Workshop  £34.00");
      expect(body).not.toContain("Decoden pieces");
      expect(body).not.toContain("{{");
    }
    expect(n.bodyHtml).toContain("<!doctype html>");
    expect(n.bodyHtml).toContain(f.org.brandPrimary);
    expect(n.bodyHtml).toContain("Company number");

    const [stored] = await f.db.select().from(s.notifications).where(eq(s.notifications.id, n.id));
    expect(stored.status).toBe("demo");
    expect(stored.attachments[0].filename).toBe("booking-BP-AAAA1.ics");
  });

  it("adds the in-store note only when a Decoden option was booked", async () => {
    const n = await sendBookingEmail(f.db, { bookingId: f.decoden.id, template: "confirmation" });
    expect(n.bodyText).toContain("Decoden pieces are bought in store on the day, £3 to £20 each.");
    expect(n.bodyHtml).toContain("Decoden pieces are bought in store on the day, £3 to £20 each.");
    expect(n.bodyText).toContain("15:00 to 16:00");
  });

  it("renders the party in GMT after the clocks change", async () => {
    const n = await sendBookingEmail(f.db, { bookingId: f.party.id, template: "confirmation" });
    expect(n.bodyText).toContain("Sunday 25 October 2026, 11:00 to 13:00");
    expect(n.attachments[0].content).toContain("DTSTART:20261025T110000Z");
    expect(n.attachments[0].content).toContain("DTEND:20261025T130000Z");
  });

  it("dedupes on booking + template when asked", async () => {
    const first = await sendBookingEmail(f.db, { bookingId: f.workshop.id, template: "reminder", dedupe: true });
    const again = await sendBookingEmail(f.db, { bookingId: f.workshop.id, template: "reminder", dedupe: true });
    expect(again.id).toBe(first.id);
    expect(first.attachments[0].filename).toBe("booking-BP-AAAA1.ics");
    const rows = await f.db
      .select()
      .from(s.notifications)
      .where(and(eq(s.notifications.bookingId, f.workshop.id), eq(s.notifications.template, "reminder")));
    expect(rows).toHaveLength(1);
    const forced = await sendBookingEmail(f.db, { bookingId: f.workshop.id, template: "reminder" });
    expect(forced.id).not.toBe(first.id);
  });

  it("attaches a CANCEL .ics to cancellations", async () => {
    const n = await sendBookingEmail(f.db, { bookingId: f.workshop.id, template: "cancellation" });
    const content = n.attachments[0].content;
    expect(content).toContain("METHOD:CANCEL");
    expect(content).toContain("STATUS:CANCELLED");
    expect(content).toContain("SEQUENCE:1");
    expect(content).toContain(`UID:${f.workshop.id}@baypook`);
  });

  it("sends the owner alert to the organisation with an admin link and no attachment", async () => {
    const r = await renderBookingEmail(f.db, { bookingId: f.party.id, template: "owner_new_party" });
    expect(r.to).toBe("hello@slimedom.com");
    expect(r.attachments).toHaveLength(0);
    expect(r.text).toContain(`/admin/bookings/${f.party.id}`);
    expect(r.text).toContain("Birthday child: Maya, age 8");
    expect(r.text).toContain("07700 900123");

    process.env.OWNER_ALERT_EMAIL = "alerts@example.com";
    try {
      const n = await sendBookingEmail(f.db, { bookingId: f.party.id, template: "owner_new_party" });
      expect(n.toAddress).toBe("alerts@example.com");
    } finally {
      delete process.env.OWNER_ALERT_EMAIL;
    }
  });

  it("records a provider failure instead of throwing", async () => {
    vi.spyOn(DemoEmailProvider.prototype, "send").mockRejectedValueOnce(new Error("boom"));
    const n = await sendBookingEmail(f.db, { bookingId: f.workshop.id, template: "refund", extra: { refundAmountPence: 1700 } });
    expect(n.status).toBe("failed");
    expect(n.error).toBe("boom");
    expect(n.subject).toContain("£17.00");
    // A failed send does not count for dedupe.
    const retry = await sendBookingEmail(f.db, { bookingId: f.workshop.id, template: "refund", dedupe: true, extra: { refundAmountPence: 1700 } });
    expect(retry.id).not.toBe(n.id);
    expect(retry.status).toBe("demo");
  });

  it("throws for an unknown booking", async () => {
    await expect(sendBookingEmail(f.db, { bookingId: "00000000-0000-4000-8000-000000000001", template: "confirmation" })).rejects.toThrow();
  });
});

describe("sendRawEmail and listOutbox", () => {
  it("records raw emails and filters the Outbox by venue and search", async () => {
    const raw = await sendRawEmail(f.db, {
      to: "owner@demo.baypook",
      subject: "Your sign-in link",
      html: "<p>link</p>",
      text: "link",
      template: "magic_link",
    });
    expect(raw.status).toBe("demo");
    expect(raw.bookingId).toBeNull();

    const all = await listOutbox(f.db, {});
    expect(all[0].id).toBe(raw.id);
    expect(all.some((n) => n.template === "confirmation")).toBe(true);

    const swOnly = await listOutbox(f.db, { venueIds: [f.sw.id] });
    expect(swOnly.length).toBeGreaterThan(0);
    expect(swOnly.every((n) => n.venueId === f.sw.id)).toBe(true);
    expect(await listOutbox(f.db, { venueIds: [f.lk.id] })).toHaveLength(0);
    expect(await listOutbox(f.db, { venueIds: [] })).toHaveLength(0);

    const search = await listOutbox(f.db, { search: "SIGN-IN" });
    expect(search.map((n) => n.id)).toEqual([raw.id]);
    expect(await listOutbox(f.db, { search: "100%_" })).toHaveLength(0);
    expect(await listOutbox(f.db, { limit: 2 })).toHaveLength(2);
  });
});

describe("previewTemplate", () => {
  it("renders all five templates with a sample booking", async () => {
    const keys: TemplateKey[] = ["confirmation", "reminder", "cancellation", "refund", "owner_new_party"];
    for (const key of keys) {
      const p = await previewTemplate(f.db, f.org.id, key);
      expect(p.subject.length).toBeGreaterThan(0);
      expect(p.subject).not.toContain("{{");
      expect(p.text).not.toContain("{{");
      expect(p.html).toContain("<!doctype html>");
      expect(p.text).toContain("BP-7K3M2");
    }
    const conf = await previewTemplate(f.db, f.org.id, "confirmation");
    expect(conf.text).toContain("Decoden pieces are bought in store");
    const owner = await previewTemplate(f.db, f.org.id, "owner_new_party");
    expect(owner.text).toContain("Slime Party");
    expect(owner.text).toContain("Birthday child: Maya");
    const refund = await previewTemplate(f.db, f.org.id, "refund");
    expect(refund.subject).toContain("£17.00");
  });

  it("renders an unsaved override", async () => {
    const p = await previewTemplate(f.db, f.org.id, "confirmation", { subject: "Hi {{firstName}}", body: "## {{venueName}}\nThanks" });
    expect(p.subject).toBe("Hi Amina");
    expect(p.text).toBe("South Woodford\nThanks");
  });
});

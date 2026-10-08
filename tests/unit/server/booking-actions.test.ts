process.env.BAYPOOK_MODE = "demo";

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { zonedDateTime } from "@/core/time";
import type { CurrentUser } from "@/server/auth";
import { getVenueBySlug } from "@/server/org";
import { getServiceBySlug, type ServiceWithCatalogue } from "@/server/catalogue";
import { BookingError, createManualBooking } from "@/server/bookings";
import { adminSessionChoices, adminSlotChoices } from "@/app/(admin)/admin/bookings/_lib/availability";
import { bookingErrorMessage } from "@/app/(admin)/admin/bookings/_lib/errors";
import { hasRealEmail, outstandingPence, overpaidPence } from "@/app/(admin)/admin/bookings/_lib/labels";
import { quantitiesFromForm } from "@/app/(admin)/admin/bookings/_lib/run";
import {
  CustomerAdminError,
  canSeeCustomer,
  updateCustomerNotes,
  visibleCustomerIds,
} from "@/app/(admin)/admin/customers/_lib/customers";

const DAY = "2026-10-24";
const TZ = "Europe/London";
// Inside the 60-minute cut-off of the 14:00 session.
const NOW = zonedDateTime(DAY, "13:30", TZ);

let db: Db;
let sw: s.Venue;
let lakeside: s.Venue;
let workshops: ServiceWithCatalogue;
let party: ServiceWithCatalogue;
let owner: CurrentUser;
let swStaff: CurrentUser;
let lakesideStaff: CurrentUser;
let booking: s.Booking;

beforeAll(async () => {
  db = await createTestDb({ seed: true });
  sw = (await getVenueBySlug(db, "south-woodford"))!;
  lakeside = (await getVenueBySlug(db, "lakeside"))!;
  workshops = (await getServiceBySlug(db, sw.id, "classic-workshops"))!;
  party = (await getServiceBySlug(db, sw.id, "slime-party"))!;
  const [ownerRow] = await db.select().from(s.users).where(eq(s.users.isOwner, true));
  owner = { id: ownerRow.id, email: ownerRow.email, name: ownerRow.name, isOwner: true, venues: [] };
  swStaff = { id: ownerRow.id, email: "sw@test", name: "SW", isOwner: false, venues: [{ venueId: sw.id, role: "staff" }] };
  lakesideStaff = { id: ownerRow.id, email: "lk@test", name: "LK", isOwner: false, venues: [{ venueId: lakeside.id, role: "staff" }] };

  const sessions = await adminSessionChoices(db, { venue: sw, service: workshops, date: DAY, tz: TZ, now: NOW });
  const two = sessions.find((x) => x.startsAt.getTime() === zonedDateTime(DAY, "14:00", TZ).getTime())!;
  booking = await createManualBooking(db, {
    user: owner,
    venue: sw,
    service: workshops,
    sessionId: two.sessionId,
    lines: [{ optionId: workshops.options[0].id, qty: 3 }],
    addOns: [],
    customer: { firstName: "Walk", lastName: "In", email: null, phone: "07700 900111" },
    payment: { method: "cash" },
    sendEmail: false,
    now: NOW,
  });
});

describe("adminSessionChoices", () => {
  it("lets staff book inside the cut-off and says so", async () => {
    const list = await adminSessionChoices(db, { venue: sw, service: workshops, date: DAY, tz: TZ, now: NOW });
    const two = list.find((x) => x.sessionId === booking.sessionId)!;
    expect(two.bookable).toBe(true);
    expect(two.timing).toBe("inside_cutoff");
    expect(two.taken).toBe(3);
    const ten = list.find((x) => x.startsAt.getTime() === zonedDateTime(DAY, "10:00", TZ).getTime())!;
    expect(ten.timing).toBe("past");
    const later = list.find((x) => x.startsAt.getTime() === zonedDateTime(DAY, "16:00", TZ).getTime())!;
    expect(later.timing).toBeNull();
  });

  it("does not count the booking being moved against itself", async () => {
    const list = await adminSessionChoices(db, { venue: sw, service: workshops, date: DAY, tz: TZ, now: NOW, excludeBookingId: booking.id });
    const two = list.find((x) => x.sessionId === booking.sessionId)!;
    expect(two.taken).toBe(0);
    expect(two.remaining).toBe(two.capacity);
  });
});

describe("adminSlotChoices", () => {
  it("blocks party starts over an occupied session and longer parties end later", async () => {
    const plain = await adminSlotChoices(db, { venue: sw, service: party, date: DAY, tz: TZ, extraMinutes: 0, now: NOW });
    const at1330 = plain.find((x) => x.startsAt.getTime() === zonedDateTime(DAY, "13:30", TZ).getTime())!;
    expect(at1330.bookable).toBe(false);
    expect(at1330.reason).toBe("room_busy");
    const withFood = await adminSlotChoices(db, { venue: sw, service: party, date: DAY, tz: TZ, extraMinutes: 30, now: NOW });
    const first = withFood[0];
    expect(first.endsAt.getTime() - first.startsAt.getTime()).toBe((party.lengthMinutes + 30) * 60_000);
  });
});

describe("customer visibility and notes", () => {
  it("shows a customer only to venues they booked at", async () => {
    expect(await canSeeCustomer(db, owner, booking.customerId)).toBe(true);
    expect(await canSeeCustomer(db, swStaff, booking.customerId)).toBe(true);
    expect(await canSeeCustomer(db, lakesideStaff, booking.customerId)).toBe(false);
    expect((await visibleCustomerIds(db, lakesideStaff, [booking.customerId, "not-a-uuid"])).size).toBe(0);
  });

  it("saves notes with an audit entry, and refuses other venues", async () => {
    const after = await updateCustomerNotes(db, { customerId: booking.customerId, user: swStaff, notes: "  Nut allergy  " });
    expect(after.notes).toBe("Nut allergy");
    const rows = await db.select().from(s.auditLog).where(eq(s.auditLog.entityId, booking.customerId));
    expect(rows.some((r) => r.action === "customer.notes")).toBe(true);
    await expect(updateCustomerNotes(db, { customerId: booking.customerId, user: lakesideStaff, notes: "x" })).rejects.toBeInstanceOf(
      CustomerAdminError,
    );
  });
});

describe("form and label helpers", () => {
  it("reads quantities from the editor's fields", () => {
    const fd = new FormData();
    fd.set("line:a", "2");
    fd.set("line:b", "0");
    fd.set("addon:c", "1");
    fd.set("addon:d", "-1");
    fd.set("other", "5");
    expect(quantitiesFromForm(fd)).toEqual({ lines: [{ optionId: "a", qty: 2 }], addOns: [{ addOnId: "c", qty: 1 }] });
  });

  it("works out money still owed and overpaid", () => {
    expect(outstandingPence({ status: "confirmed", totalPence: 5000, paidPence: 3400 })).toBe(1600);
    expect(outstandingPence({ status: "cancelled", totalPence: 5000, paidPence: 0 })).toBe(0);
    expect(overpaidPence({ status: "confirmed", totalPence: 3400, paidPence: 5100, refundedPence: 0 })).toBe(1700);
    expect(overpaidPence({ status: "confirmed", totalPence: 3400, paidPence: 5100, refundedPence: 1700 })).toBe(0);
  });

  it("treats blank and placeholder addresses as no email", () => {
    expect(hasRealEmail("")).toBe(false);
    expect(hasRealEmail("no-email@south-woodford.local")).toBe(false);
    expect(hasRealEmail("amina@example.com")).toBe(true);
  });

  it("maps booking errors to their plain message", () => {
    expect(bookingErrorMessage(new BookingError("LIMIT", "You can refund up to £34.00.", { limit: 3400 }))).toBe("You can refund up to £34.00.");
  });
});

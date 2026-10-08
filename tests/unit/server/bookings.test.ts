process.env.BAYPOOK_MODE = "demo";

import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { zonedDateTime } from "@/core/time";
import type { CurrentUser } from "@/server/auth";
import { getVenueBySlug } from "@/server/org";
import { getServiceBySlug, type ServiceWithCatalogue } from "@/server/catalogue";
import { getSessionAvailability } from "@/server/availability";
import { createHold } from "@/server/holds";
import { startCheckout } from "@/server/checkout";
import {
  addBookingNote,
  BookingError,
  cancelBooking,
  changeBookingCounts,
  confirmBookingPaid,
  createManualBooking,
  getBookingDetail,
  listBookings,
  markNoShow,
  markPaidInStore,
  moveBooking,
  refundBooking,
  resendConfirmation,
} from "@/server/bookings";
import { findOrCreateCustomer, getCustomerWithBookings, searchCustomers } from "@/server/customers";
import { handleStripeEvent, type WebhookEvent } from "@/server/webhooks";
import { expireHoldsJob, listJobRuns, runJob } from "@/server/jobs";

const NOW = new Date("2026-10-10T09:00:00Z");
const DAY = "2026-10-24";

type Ctx = {
  db: Db;
  venue: s.Venue;
  workshops: ServiceWithCatalogue;
  party: ServiceWithCatalogue;
  owner: CurrentUser;
  staff: CurrentUser;
  manager: CurrentUser;
  sessions: Map<string, string>;
};

let c: Ctx;

async function setup(): Promise<Ctx> {
  const db = await createTestDb({ seed: true });
  const venue = (await getVenueBySlug(db, "south-woodford"))!;
  const workshops = (await getServiceBySlug(db, venue.id, "classic-workshops"))!;
  const party = (await getServiceBySlug(db, venue.id, "slime-party"))!;
  const users = await db.select().from(s.users);
  const ownerRow = users.find((u) => u.isOwner)!;
  const other = users.find((u) => !u.isOwner)!;
  const avail = await getSessionAvailability(db, { venue, service: workshops, from: DAY, to: DAY, now: NOW });
  const sessions = new Map(avail.map((a) => [a.startsAt.toISOString(), a.sessionId]));
  return {
    db,
    venue,
    workshops,
    party,
    sessions,
    owner: { id: ownerRow.id, email: ownerRow.email, name: ownerRow.name, isOwner: true, venues: [] },
    staff: { id: other.id, email: "staff@test", name: "Staff", isOwner: false, venues: [{ venueId: venue.id, role: "staff" }] },
    manager: { id: other.id, email: "manager@test", name: "Manager", isOwner: false, venues: [{ venueId: venue.id, role: "manager" }] },
  };
}

const sessionId = (time: string) => c.sessions.get(zonedDateTime(DAY, time).toISOString())!;
const slime = () => c.workshops.options.find((o) => o.name === "Slime Workshop")!.id;

/** An online booking paid through the demo provider. */
async function paidBooking(time: string, qty: number): Promise<s.Booking> {
  const { hold } = await createHold(c.db, {
    venue: c.venue,
    service: c.workshops,
    holdMinutes: 15,
    sessionId: sessionId(time),
    lines: [{ optionId: slime(), qty }],
    addOns: [],
    now: NOW,
  });
  const co = await startCheckout(c.db, {
    holdId: hold.id,
    customer: { firstName: "Amina", lastName: "Khan", email: "amina@example.com", phone: "07700 900123" },
    accept: { terms: true, waiver: true },
    now: NOW,
  });
  const res = await confirmBookingPaid(c.db, {
    bookingId: co.bookingId,
    payment: { provider: "demo", providerCheckoutId: `demo_cs_${co.bookingId}`, amountPence: qty * 1700, currency: "gbp" },
    now: NOW,
  });
  return res.booking;
}

async function pendingBooking(time: string, qty: number): Promise<string> {
  const { hold } = await createHold(c.db, {
    venue: c.venue,
    service: c.workshops,
    holdMinutes: 15,
    sessionId: sessionId(time),
    lines: [{ optionId: slime(), qty }],
    addOns: [],
    now: NOW,
  });
  const co = await startCheckout(c.db, {
    holdId: hold.id,
    customer: { firstName: "Ben", lastName: "Ode", email: "ben@example.com", phone: "07700 900124" },
    accept: { terms: true, waiver: true },
    now: NOW,
  });
  return co.bookingId;
}

function manual(time: string, qty: number, method: "cash" | "card_machine" | "pay_in_store" = "pay_in_store") {
  return createManualBooking(c.db, {
    user: c.owner,
    venue: c.venue,
    service: c.workshops,
    sessionId: sessionId(time),
    lines: [{ optionId: slime(), qty }],
    addOns: [],
    customer: { firstName: "Walk", lastName: "In", email: "", phone: null },
    payment: { method },
    sendEmail: false,
    now: NOW,
  });
}

async function expectCode(p: Promise<unknown>, code: BookingError["code"], limit?: number): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BookingError);
  expect((err as BookingError).code).toBe(code);
  if (limit !== undefined) expect((err as BookingError).limit).toBe(limit);
}

async function templates(bookingId: string): Promise<string[]> {
  const rows = await c.db.select().from(s.notifications).where(eq(s.notifications.bookingId, bookingId));
  return rows.map((r) => r.template);
}

beforeEach(async () => {
  c = await setup();
});

describe("cancel and refund", () => {
  it("cancels with a full refund through the demo provider, updating the ledger and emailing", async () => {
    const b = await paidBooking("14:00", 2);
    const cancelled = await cancelBooking(c.db, { bookingId: b.id, user: c.owner, reason: "Poorly child", refund: { amountPence: 3400 }, now: NOW });
    expect(cancelled).toMatchObject({ status: "cancelled", refundedPence: 3400, paymentStatus: "refunded", cancelReason: "Poorly child" });
    const [refund] = await c.db.select().from(s.refunds).where(eq(s.refunds.bookingId, b.id));
    expect(refund).toMatchObject({ amountPence: 3400, status: "succeeded", createdBy: c.owner.id });
    expect(refund.providerRefundId).toMatch(/^demo_re_/);
    const [payment] = await c.db.select().from(s.payments).where(eq(s.payments.bookingId, b.id));
    expect(payment.status).toBe("refunded");
    expect(await templates(b.id)).toEqual(expect.arrayContaining(["confirmation", "refund", "cancellation"]));
    const cal = await c.db.select().from(s.calendarLog).where(and(eq(s.calendarLog.bookingId, b.id), eq(s.calendarLog.action, "delete")));
    expect(cal).toHaveLength(1);
    const audits = await c.db.select().from(s.auditLog).where(eq(s.auditLog.entityId, b.id));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["booking.refund", "booking.cancel"]));
    // The places are free again.
    const avail = await getSessionAvailability(c.db, { venue: c.venue, service: c.workshops, from: DAY, to: DAY, now: NOW });
    expect(avail.find((a) => a.sessionId === sessionId("14:00"))!.remaining).toBe(10);
  });

  it("gives a partial refund and refuses more than was paid", async () => {
    const b = await paidBooking("14:00", 2);
    await refundBooking(c.db, { bookingId: b.id, user: c.manager, amountPence: 1700, reason: "One child could not come" });
    const detail = await getBookingDetail(c.db, b.id);
    // The total is unchanged, so after giving 1700 back the booking owes it again (owed comes first).
    expect(detail!.booking).toMatchObject({ refundedPence: 1700, paymentStatus: "owed", status: "confirmed" });
    expect(detail!.payments[0].status).toBe("partially_refunded");
    await expectCode(refundBooking(c.db, { bookingId: b.id, user: c.owner, amountPence: 1800, reason: "x" }), "LIMIT", 1700);
    await expectCode(refundBooking(c.db, { bookingId: b.id, user: c.owner, amountPence: 0, reason: "x" }), "INVALID");
  });

  it("does not let staff give a refund", async () => {
    const b = await paidBooking("14:00", 2);
    await expectCode(refundBooking(c.db, { bookingId: b.id, user: c.staff, amountPence: 100, reason: "x" }), "FORBIDDEN");
    await expectCode(cancelBooking(c.db, { bookingId: b.id, user: c.staff, reason: "x", refund: { amountPence: 100 } }), "FORBIDDEN");
    const [row] = await c.db.select().from(s.bookings).where(eq(s.bookings.id, b.id));
    expect(row.status).toBe("confirmed");
  });

  it("does not let staff of another venue touch the booking", async () => {
    const b = await paidBooking("14:00", 1);
    const lakesideStaff: CurrentUser = { ...c.staff, venues: [{ venueId: "00000000-0000-4000-8000-000000000000", role: "staff" }] };
    await expectCode(markNoShow(c.db, { bookingId: b.id, user: lakesideStaff }), "FORBIDDEN");
  });
});

describe("payments in store", () => {
  it("marks a pay-in-store booking as paid", async () => {
    const b = await manual("15:00", 2);
    expect(b).toMatchObject({ status: "confirmed", paymentStatus: "owed", paidPence: 0, source: "manual" });
    const payment = await markPaidInStore(c.db, { bookingId: b.id, user: c.staff, method: "cash", amountPence: 3400 });
    expect(payment).toMatchObject({ provider: "manual", method: "cash", status: "succeeded", amountPence: 3400 });
    const [row] = await c.db.select().from(s.bookings).where(eq(s.bookings.id, b.id));
    expect(row).toMatchObject({ paidPence: 3400, paymentStatus: "paid" });
  });

  it("records a manual cash booking with its payment", async () => {
    const b = await manual("15:00", 1, "cash");
    expect(b).toMatchObject({ paidPence: 1700, paymentStatus: "paid", paymentMethod: "cash" });
    const payments = await c.db.select().from(s.payments).where(eq(s.payments.bookingId, b.id));
    expect(payments).toHaveLength(1);
  });
});

describe("moves and changes", () => {
  it("refuses to move into a full session (GONE)", async () => {
    await manual("15:00", 10);
    const b = await paidBooking("14:00", 2);
    await expectCode(moveBooking(c.db, { bookingId: b.id, user: c.owner, sessionId: sessionId("15:00"), now: NOW }), "GONE");
  });

  it("moves into a session with room and re-sends the confirmation", async () => {
    const b = await paidBooking("14:00", 2);
    const moved = await moveBooking(c.db, { bookingId: b.id, user: c.owner, sessionId: sessionId("16:00"), now: NOW });
    expect(moved.sessionId).toBe(sessionId("16:00"));
    expect(moved.startsAt.toISOString()).toBe(zonedDateTime(DAY, "16:00").toISOString());
    expect((await templates(b.id)).filter((t) => t === "confirmation")).toHaveLength(2);
  });

  it("refuses more places than are left (LIMIT) and more than the venue allows", async () => {
    await manual("14:00", 7);
    const b = await paidBooking("14:00", 2);
    await expectCode(
      changeBookingCounts(c.db, { bookingId: b.id, user: c.owner, lines: [{ optionId: slime(), qty: 4 }], addOns: [], now: NOW }),
      "LIMIT",
      3,
    );
    await expectCode(
      changeBookingCounts(c.db, { bookingId: b.id, user: c.owner, lines: [{ optionId: slime(), qty: 11 }], addOns: [], now: NOW }),
      "LIMIT",
      10,
    );
  });

  it("leaves the extra owed when counts go up and reports a refund hint when they go down", async () => {
    const b = await paidBooking("14:00", 2);
    const up = await changeBookingCounts(c.db, { bookingId: b.id, user: c.owner, lines: [{ optionId: slime(), qty: 3 }], addOns: [], now: NOW });
    expect(up.delta).toBe(1700);
    expect(up.booking).toMatchObject({ places: 3, totalPence: 5100, paymentStatus: "owed" });
    const down = await changeBookingCounts(c.db, { bookingId: b.id, user: c.owner, lines: [{ optionId: slime(), qty: 1 }], addOns: [], now: NOW });
    expect(down.delta).toBe(-1700);
    expect(down.booking.paymentStatus).toBe("paid");
  });

  it("marks and undoes a no-show, adds a note and resends the confirmation", async () => {
    const b = await paidBooking("14:00", 1);
    expect((await markNoShow(c.db, { bookingId: b.id, user: c.staff })).status).toBe("no_show");
    expect((await markNoShow(c.db, { bookingId: b.id, user: c.staff, undo: true })).status).toBe("confirmed");
    expect((await addBookingNote(c.db, { bookingId: b.id, user: c.staff, notes: "Nut allergy" })).notes).toBe("Nut allergy");
    const n = await resendConfirmation(c.db, { bookingId: b.id, user: c.staff });
    expect(n.template).toBe("confirmation");
  });
});

describe("pending bookings and jobs", () => {
  it("expires the hold of an abandoned checkout and records the job run", async () => {
    const id = await pendingBooking("14:00", 2);
    const run = await runJob(c.db, "expire-holds", "test", () => expireHoldsJob(c.db, new Date(NOW.getTime() + 16 * 60_000)));
    expect(run.status).toBe("ok");
    expect(run.summary).toMatchObject({ expired: 1, bookingsCancelled: 1 });
    const [b] = await c.db.select().from(s.bookings).where(eq(s.bookings.id, id));
    expect(b.status).toBe("cancelled");
    const [p] = await c.db.select().from(s.payments).where(eq(s.payments.bookingId, id));
    expect(p.status).toBe("failed");
    expect((await listJobRuns(c.db, { limit: 5 }))[0].job).toBe("expire-holds");
  });

  it("records a failed job without throwing", async () => {
    const run = await runJob(c.db, "boom", "test", async () => {
      throw new Error("nope");
    });
    expect(run).toMatchObject({ status: "failed", error: "nope" });
  });
});

describe("Stripe webhooks", () => {
  function completed(id: string, bookingId: string): WebhookEvent {
    return {
      id,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          payment_status: "paid",
          payment_intent: "pi_test_123",
          amount_total: 3400,
          currency: "gbp",
          metadata: { bookingId },
        },
      },
    } as unknown as WebhookEvent;
  }

  it("processes an event once and ignores the repeat", async () => {
    const bookingId = await pendingBooking("14:00", 2);
    const first = await handleStripeEvent(c.db, { venue: c.venue, event: completed("evt_1", bookingId) });
    expect(first).toMatchObject({ action: "confirmed", bookingId });
    const second = await handleStripeEvent(c.db, { venue: c.venue, event: completed("evt_1", bookingId) });
    expect(second.duplicate).toBe(true);
    const stripePayments = await c.db
      .select()
      .from(s.payments)
      .where(and(eq(s.payments.bookingId, bookingId), eq(s.payments.provider, "stripe")));
    expect(stripePayments).toHaveLength(1);
    const [b] = await c.db.select().from(s.bookings).where(eq(s.bookings.id, bookingId));
    expect(b).toMatchObject({ status: "confirmed", paidPence: 3400, paymentStatus: "paid" });

    // The belt-and-braces payment_intent.succeeded for the same payment changes nothing.
    const pi = await handleStripeEvent(c.db, {
      venue: c.venue,
      event: {
        id: "evt_2",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_test_123", amount_received: 3400, currency: "gbp", latest_charge: "ch_1", metadata: { bookingId } } },
      },
    });
    expect(pi.action).toBe("already_confirmed");
    const [b2] = await c.db.select().from(s.bookings).where(eq(s.bookings.id, bookingId));
    expect(b2.paidPence).toBe(3400);
  });

  it("syncs a refund made in Stripe and flags a dispute", async () => {
    const bookingId = await pendingBooking("14:00", 2);
    await handleStripeEvent(c.db, { venue: c.venue, event: completed("evt_a", bookingId) });
    const refunded = await handleStripeEvent(c.db, {
      venue: c.venue,
      event: {
        id: "evt_b",
        type: "charge.refunded",
        data: {
          object: { id: "ch_9", payment_intent: "pi_test_123", amount_refunded: 1700, refunds: { data: [{ id: "re_1", amount: 1700, status: "succeeded" }] } },
        },
      },
    });
    expect(refunded.bookingId).toBe(bookingId);
    const [b] = await c.db.select().from(s.bookings).where(eq(s.bookings.id, bookingId));
    expect(b).toMatchObject({ refundedPence: 1700, paymentStatus: "owed" });
    // Seeing the same refund again (another event) adds nothing.
    await handleStripeEvent(c.db, {
      venue: c.venue,
      event: {
        id: "evt_c",
        type: "charge.refunded",
        data: { object: { id: "ch_9", payment_intent: "pi_test_123", refunds: { data: [{ id: "re_1", amount: 1700, status: "succeeded" }] } } },
      },
    });
    const refunds = await c.db.select().from(s.refunds).where(eq(s.refunds.bookingId, bookingId));
    expect(refunds).toHaveLength(1);

    const disputed = await handleStripeEvent(c.db, {
      venue: c.venue,
      event: { id: "evt_d", type: "charge.dispute.created", data: { object: { id: "dp_1", charge: "ch_9", amount: 3400, reason: "fraudulent" } } },
    });
    expect(disputed.action).toBe("disputed");
    const [p] = await c.db.select().from(s.payments).where(and(eq(s.payments.bookingId, bookingId), eq(s.payments.provider, "stripe")));
    expect(p).toMatchObject({ status: "disputed", disputeId: "dp_1" });
    const alerts = await c.db.select().from(s.notifications).where(eq(s.notifications.template, "owner_dispute"));
    expect(alerts).toHaveLength(1);
  });

  it("cancels a pending booking when its checkout expires, and ignores unknown events", async () => {
    const bookingId = await pendingBooking("14:00", 1);
    await handleStripeEvent(c.db, {
      venue: c.venue,
      event: { id: "evt_x", type: "checkout.session.expired", data: { object: { id: "cs_x", metadata: { bookingId } } } },
    });
    const [b] = await c.db.select().from(s.bookings).where(eq(s.bookings.id, bookingId));
    expect(b.status).toBe("cancelled");
    const other = await handleStripeEvent(c.db, { venue: c.venue, event: { id: "evt_y", type: "customer.created", data: { object: {} } } });
    expect(other.ignored).toBe(true);
  });
});

describe("customers and lists", () => {
  it("matches customers by e-mail case-insensitively and finds them by name or phone", async () => {
    const [org] = await c.db.select().from(s.organisations);
    const a = await findOrCreateCustomer(c.db, { organisationId: org.id, firstName: "Amina", lastName: "Khan", email: "Amina@Example.com", phone: "07700 900123" });
    const b = await findOrCreateCustomer(c.db, { organisationId: org.id, firstName: "Amina", lastName: "Khan-Ali", email: "amina@example.com", phone: null });
    expect(b.id).toBe(a.id);
    expect(b.lastName).toBe("Khan-Ali");
    expect((await searchCustomers(c.db, { q: "khan-al" })).map((x) => x.id)).toContain(a.id);
    expect((await searchCustomers(c.db, { q: "07700900123" })).map((x) => x.id)).toContain(a.id);
    const booking = await paidBooking("14:00", 1);
    const withBookings = await getCustomerWithBookings(c.db, booking.customerId);
    expect(withBookings!.bookings.map((x) => x.id)).toContain(booking.id);
    const list = await listBookings(c.db, { venueIds: [c.venue.id], search: booking.reference });
    expect(list.map((x) => x.booking.id)).toEqual([booking.id]);
    expect(await listBookings(c.db, { venueIds: [] })).toEqual([]);
  });
});

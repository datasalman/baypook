/**
 * Regression tests for the correctness and security review findings on the
 * booking service (C1-C16, S5, S6). Each `describe` names its finding.
 */
process.env.BAYPOOK_MODE = "demo";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { zonedDateTime } from "@/core/time";
import type { CurrentUser } from "@/server/auth";
import { getVenueBySlug } from "@/server/org";
import { getService, getServiceBySlug, type ServiceWithCatalogue } from "@/server/catalogue";
import { getSessionAvailability } from "@/server/availability";
import { createHold, HoldError, lockActiveHold } from "@/server/holds";
import { startCheckout } from "@/server/checkout";
import {
  BookingError,
  cancelBooking,
  changeBookingCounts,
  confirmBookingPaid,
  createManualBooking,
  derivePaymentStatus,
  keepSoldPrices,
  markNoShow,
  moveBooking,
  refundBooking,
} from "@/server/bookings";
import { handleStripeEvent, type WebhookEvent } from "@/server/webhooks";
import { expireHoldsJob } from "@/server/jobs";
import { remindersJob } from "@/server/jobs-reminders";
import { updateService } from "@/server/catalogue-admin";
import { DemoPaymentProvider } from "@/providers/payment/demo";

const NOW = new Date("2026-10-10T09:00:00Z");
const DAY = "2026-10-24";

type Ctx = {
  db: Db;
  venue: s.Venue;
  workshops: ServiceWithCatalogue;
  owner: CurrentUser;
  sessions: Map<string, string>;
};

let c: Ctx;

async function sessionsFor(db: Db, venue: s.Venue, service: ServiceWithCatalogue): Promise<Map<string, string>> {
  const avail = await getSessionAvailability(db, { venue, service, from: DAY, to: DAY, now: NOW });
  return new Map(avail.map((a) => [a.startsAt.toISOString(), a.sessionId]));
}

beforeEach(async () => {
  const db = await createTestDb({ seed: true });
  const venue = (await getVenueBySlug(db, "south-woodford"))!;
  const workshops = (await getServiceBySlug(db, venue.id, "classic-workshops"))!;
  const [ownerRow] = await db.select().from(s.users).where(eq(s.users.isOwner, true));
  c = {
    db,
    venue,
    workshops,
    sessions: await sessionsFor(db, venue, workshops),
    owner: { id: ownerRow.id, email: ownerRow.email, name: ownerRow.name, isOwner: true, venues: [] },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const at = (time: string) => zonedDateTime(DAY, time).toISOString();
const sessionId = (time: string) => c.sessions.get(at(time))!;
const slime = () => c.workshops.options.find((o) => o.name === "Slime Workshop")!.id;
const customer = { firstName: "Amina", lastName: "Khan", email: "amina@example.com", phone: "07700 900123" };

async function hold(time: string, qty: number, service = c.workshops, venue = c.venue, sid = sessionId(time)) {
  const res = await createHold(c.db, {
    venue,
    service,
    holdMinutes: 15,
    sessionId: sid,
    lines: [{ optionId: service.options[0].id, qty }],
    addOns: [],
    now: NOW,
  });
  return res.hold;
}

function checkout(holdId: string, now = NOW) {
  return startCheckout(c.db, { holdId, customer, accept: { terms: true, waiver: true }, now });
}

function manual(time: string, qty: number, method: "cash" | "card_machine" | "pay_in_store" = "cash") {
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

async function remaining(time: string, service = c.workshops, venue = c.venue): Promise<number> {
  const avail = await getSessionAvailability(c.db, { venue, service, from: DAY, to: DAY, now: NOW });
  return avail.find((a) => a.startsAt.toISOString() === at(time))!.remaining;
}

async function booking(id: string): Promise<s.Booking> {
  const [row] = await c.db.select().from(s.bookings).where(eq(s.bookings.id, id));
  return row;
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

async function expectCode(p: Promise<unknown>, code: BookingError["code"], limit?: number): Promise<void> {
  const err = await errorOf(p);
  expect(err).toBeInstanceOf(BookingError);
  expect((err as BookingError).code).toBe(code);
  if (limit !== undefined) expect((err as BookingError).limit).toBe(limit);
}

/** A pending online booking confirmed through the Stripe webhook (a `stripe` payment with intent `pi_<n>`). */
async function stripePaid(time: string, qty: number, n: number): Promise<s.Booking> {
  const h = await hold(time, qty);
  const co = await checkout(h.id);
  const res = await handleStripeEvent(c.db, {
    venue: c.venue,
    event: {
      id: `evt_paid_${n}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_${n}`,
          payment_status: "paid",
          payment_intent: `pi_${n}`,
          amount_total: qty * 1700,
          currency: "gbp",
          metadata: { bookingId: co.bookingId },
        },
      },
    },
  });
  expect(res.action).toBe("confirmed");
  return booking(co.bookingId);
}

describe("C1: leftover sessions referenced by dead holds or bookings", () => {
  it("keeps availability working after a 'cancel one time' exception on a session with an expired hold", async () => {
    const h = await hold("14:00", 2);
    await expireHoldsJob(c.db, new Date(NOW.getTime() + 20 * 60_000));
    const [expired] = await c.db.select().from(s.holds).where(eq(s.holds.id, h.id));
    expect(expired.status).toBe("expired");
    // And a cancelled booking on another session.
    const b = await manual("15:00", 1);
    await cancelBooking(c.db, { bookingId: b.id, user: c.owner, reason: "Changed plans", now: NOW });

    await c.db.insert(s.timetableExceptions).values([
      { serviceId: c.workshops.id, date: DAY, startTime: "14:00", kind: "cancel" },
      { serviceId: c.workshops.id, date: DAY, startTime: "15:00", kind: "cancel" },
      { serviceId: c.workshops.id, date: DAY, startTime: "16:00", kind: "cancel" },
    ]);

    const avail = await getSessionAvailability(c.db, { venue: c.venue, service: c.workshops, from: DAY, to: DAY, now: NOW });
    // 14:00 and 15:00 are kept (referenced) but cancelled; 16:00 had nothing and is gone.
    for (const time of ["14:00", "15:00"]) {
      const a = avail.find((x) => x.startsAt.toISOString() === at(time))!;
      expect(a).toMatchObject({ bookable: false, reason: "cancelled" });
    }
    expect(avail.find((x) => x.startsAt.toISOString() === at("16:00"))).toBeUndefined();
    const [kept] = await c.db.select().from(s.sessions).where(eq(s.sessions.id, sessionId("14:00")));
    // Cancelled but not pinned, so it comes back if the timetable produces it again (round 2, finding 2).
    expect(kept).toMatchObject({ pinned: false, source: "rule", status: "cancelled" });
    // A second call is just as happy.
    await expect(getSessionAvailability(c.db, { venue: c.venue, service: c.workshops, from: DAY, to: DAY, now: NOW })).resolves.toBeDefined();
  });
});

describe("C2: two checkouts on one hold", () => {
  it("leaves exactly one pending booking and counts the places once", async () => {
    const h = await hold("14:00", 3);
    const first = await checkout(h.id);
    const second = await checkout(h.id);
    const pending = await c.db
      .select()
      .from(s.bookings)
      .where(and(eq(s.bookings.holdId, h.id), eq(s.bookings.status, "pending")));
    expect(pending.map((b) => b.id)).toEqual([second.bookingId]);
    expect((await booking(first.bookingId)).status).toBe("cancelled");
    const [row] = await c.db.select().from(s.holds).where(eq(s.holds.id, h.id));
    expect(row.bookingId).toBe(second.bookingId);
    expect(await remaining("14:00")).toBe(7);
  });

  // On PGlite (one connection) the two calls run one after the other, so this proves the
  // re-read of the hold under its lock rather than real row-lock contention; Postgres adds the wait.
  it("serialises checkouts started at the same moment", async () => {
    const h = await hold("14:00", 2);
    const results = await Promise.allSettled([checkout(h.id), checkout(h.id)]);
    // The one superseded while its payment page was being made is refused (round 2, finding 6).
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "STATE" });
    }
    const pending = await c.db
      .select()
      .from(s.bookings)
      .where(and(eq(s.bookings.holdId, h.id), eq(s.bookings.status, "pending")));
    expect(pending).toHaveLength(1);
    expect(ok.map((r) => r.value.bookingId)).toContain(pending[0].id);
    // Only the surviving booking's payment page is recorded, on the hold and as a pending payment.
    const [row] = await c.db.select().from(s.holds).where(eq(s.holds.id, h.id));
    expect(row.checkoutId).toBe(`demo_cs_${pending[0].id}`);
    const pendingPayments = await c.db.select().from(s.payments).where(eq(s.payments.status, "pending"));
    expect(pendingPayments.map((p) => p.bookingId)).toEqual([pending[0].id]);
    expect(await remaining("14:00")).toBe(8);
  });

  it("re-checks the hold under the lock: a hold that lapsed or was released is refused", async () => {
    const h = await hold("14:00", 1);
    await expect(c.db.transaction((tx) => lockActiveHold(tx, h.id, NOW))).resolves.toMatchObject({ id: h.id });
    await c.db.update(s.holds).set({ status: "released" }).where(eq(s.holds.id, h.id));
    const err = await errorOf(c.db.transaction((tx) => lockActiveHold(tx, h.id, NOW)));
    expect(err).toBeInstanceOf(HoldError);
    expect((err as HoldError).code).toBe("HOLD_EXPIRED");
    const h2 = await hold("15:00", 1);
    const late = await errorOf(c.db.transaction((tx) => lockActiveHold(tx, h2.id, new Date(NOW.getTime() + 16 * 60_000))));
    expect((late as HoldError).code).toBe("HOLD_EXPIRED");
    expect((await errorOf(checkout(h.id))) as HoldError).toMatchObject({ code: "HOLD_EXPIRED" });
  });
});

describe("C3: paying a superseded booking", () => {
  async function superseded() {
    const h = await hold("14:00", 2);
    const b1 = await checkout(h.id);
    const b2 = await checkout(h.id);
    return { h, b1, b2 };
  }

  it("reinstates it, cancels the pending booking that replaced it and keeps the hold pointing at that one", async () => {
    const { h, b1, b2 } = await superseded();
    const expire = vi.spyOn(DemoPaymentProvider.prototype, "expireCheckout");
    const res = await confirmBookingPaid(c.db, {
      bookingId: b1.bookingId,
      payment: { provider: "demo", providerCheckoutId: `demo_cs_${b1.bookingId}`, amountPence: 3400, currency: "gbp" },
      now: NOW,
    });
    expect(res.booking.status).toBe("confirmed");
    expect(await booking(b2.bookingId)).toMatchObject({ status: "cancelled", cancelReason: "abandoned" });
    const [row] = await c.db.select().from(s.holds).where(eq(s.holds.id, h.id));
    expect(row.bookingId).toBe(b2.bookingId);
    expect(row.status).not.toBe("converted");
    expect(await remaining("14:00")).toBe(8);
    // The replaced booking's payment page is closed.
    expect(expire).toHaveBeenCalledWith(`demo_cs_${b2.bookingId}`);
  });

  it("leaves the other pending booking alone when the reinstated one no longer fits", async () => {
    const { b1, b2 } = await superseded();
    await c.db.update(s.sessions).set({ status: "cancelled", pinned: true }).where(eq(s.sessions.id, sessionId("14:00")));
    const res = await confirmBookingPaid(c.db, {
      bookingId: b1.bookingId,
      payment: { provider: "demo", providerCheckoutId: `demo_cs_${b1.bookingId}`, amountPence: 3400, currency: "gbp" },
      now: NOW,
    });
    expect(res.booking.status).toBe("cancelled");
    expect((await booking(b2.bookingId)).status).toBe("pending");
  });
});

describe("C4: changing a service's room", () => {
  it("keeps counting the places already sold, and refuses more than are left", async () => {
    const lakeside = (await getVenueBySlug(c.db, "lakeside"))!;
    const lkWorkshops = (await getServiceBySlug(c.db, lakeside.id, "classic-workshops"))!;
    const lkSessions = await sessionsFor(c.db, lakeside, lkWorkshops);
    const sid = lkSessions.get(at("14:00"))!;
    const oldRoom = lkWorkshops.roomId;
    const manualLk = (qty: number, service: ServiceWithCatalogue) =>
      createManualBooking(c.db, {
        user: c.owner,
        venue: lakeside,
        service,
        sessionId: sid,
        lines: [{ optionId: service.options[0].id, qty }],
        addOns: [],
        customer: { firstName: "Walk", lastName: "In", email: "", phone: null },
        payment: { method: "cash" },
        sendEmail: false,
        now: NOW,
      });
    const b = await manualLk(8, lkWorkshops);
    expect(b.roomId).toBe(oldRoom);

    const [partyRoom] = await c.db
      .select()
      .from(s.rooms)
      .where(and(eq(s.rooms.venueId, lakeside.id), eq(s.rooms.name, "Party room")));
    await updateService(c.db, c.owner, lkWorkshops.id, { roomId: partyRoom.id });
    const moved = (await getService(c.db, lkWorkshops.id))!;
    expect(moved.roomId).toBe(partyRoom.id);

    // The booked session stays where its customers were told it is.
    const [session] = await c.db.select().from(s.sessions).where(eq(s.sessions.id, sid));
    expect(session).toMatchObject({ roomId: oldRoom, pinned: true });
    expect(await remaining("14:00", moved, lakeside)).toBe(2);
    await expectCode(manualLk(10, moved), "LIMIT", 2);

    // A hold on it stores the session's room, not the service's.
    const h = await hold("14:00", 1, moved, lakeside, sid);
    expect(h.roomId).toBe(oldRoom);
    // An unbooked session does move.
    const [other] = await c.db.select().from(s.sessions).where(eq(s.sessions.id, lkSessions.get(at("15:00"))!));
    expect(other.roomId).toBe(partyRoom.id);
  });
});

describe("C6: refunds at the same moment", () => {
  // As above: on PGlite the two refunds are serialised, so this proves the re-check of
  // `paid − refunded` on the locked booking row, not concurrent lock waits.
  it("refunds the full amount once; the second gets LIMIT or STATE", async () => {
    const b = await stripePaid("14:00", 2, 1);
    const results = await Promise.allSettled([
      refundBooking(c.db, { bookingId: b.id, user: c.owner, amountPence: 3400, reason: "Poorly" }),
      refundBooking(c.db, { bookingId: b.id, user: c.owner, amountPence: 3400, reason: "Poorly" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BookingError);
    expect(["LIMIT", "STATE"]).toContain((rejected.reason as BookingError).code);

    const after = await booking(b.id);
    expect(after.refundedPence).toBe(after.paidPence);
    expect(after.paidPence).toBe(3400);
    const refunds = await c.db.select().from(s.refunds).where(eq(s.refunds.bookingId, b.id));
    expect(refunds.filter((r) => r.status !== "failed").reduce((n, r) => n + r.amountPence, 0)).toBe(3400);
    expect(refunds[0].providerRefundId).toMatch(/^demo_re_/);
    // A second sequential refund is refused too.
    await expectCode(refundBooking(c.db, { bookingId: b.id, user: c.owner, amountPence: 1, reason: "x" }), "STATE");
  });

  it("gives the reservation back when the provider refund fails", async () => {
    const b = await stripePaid("14:00", 2, 2);
    vi.spyOn(DemoPaymentProvider.prototype, "refund").mockRejectedValueOnce(new Error("card expired"));
    await expectCode(refundBooking(c.db, { bookingId: b.id, user: c.owner, amountPence: 1700, reason: "x" }), "UNAVAILABLE");
    expect(await booking(b.id)).toMatchObject({ refundedPence: 0, paymentStatus: "paid" });
    const [refund] = await c.db.select().from(s.refunds).where(eq(s.refunds.bookingId, b.id));
    expect(refund.status).toBe("failed");
    const [payment] = await c.db.select().from(s.payments).where(and(eq(s.payments.bookingId, b.id), eq(s.payments.provider, "stripe")));
    expect(payment.status).toBe("succeeded");
  });
});

describe("C10: charge.refunded reconciliation", () => {
  function refundedEvent(id: string, n: number, refunds: { id: string; amount: number; status: string }[]): WebhookEvent {
    return { id, type: "charge.refunded", data: { object: { id: `ch_${n}`, payment_intent: `pi_${n}`, refunds: { data: refunds } } } };
  }

  it("matches an admin refund by its provider id, and reverses it when it fails", async () => {
    const b = await stripePaid("14:00", 2, 3);
    const refund = await refundBooking(c.db, { bookingId: b.id, user: c.owner, amountPence: 1700, reason: "x" });
    await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundedEvent("evt_r1", 3, [{ id: refund.providerRefundId!, amount: 1700, status: "succeeded" }]),
    });
    expect(await c.db.select().from(s.refunds).where(eq(s.refunds.bookingId, b.id))).toHaveLength(1);
    expect((await booking(b.id)).refundedPence).toBe(1700);

    await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundedEvent("evt_r2", 3, [{ id: refund.providerRefundId!, amount: 1700, status: "failed" }]),
    });
    expect(await booking(b.id)).toMatchObject({ refundedPence: 0, paymentStatus: "paid" });
    const [payment] = await c.db.select().from(s.payments).where(and(eq(s.payments.bookingId, b.id), eq(s.payments.provider, "stripe")));
    expect(payment.status).toBe("succeeded");
  });

  it("matches a still-pending admin refund (no provider id yet) by amount instead of adding another", async () => {
    const b = await stripePaid("14:00", 2, 4);
    const [payment] = await c.db.select().from(s.payments).where(and(eq(s.payments.bookingId, b.id), eq(s.payments.provider, "stripe")));
    // What refundBooking's reservation leaves while it waits for the provider.
    await c.db.insert(s.refunds).values({ paymentId: payment.id, bookingId: b.id, amountPence: 1700, reason: "x", status: "pending" });
    await c.db.update(s.bookings).set({ refundedPence: 1700 }).where(eq(s.bookings.id, b.id));

    await handleStripeEvent(c.db, { venue: c.venue, event: refundedEvent("evt_r3", 4, [{ id: "re_late", amount: 1700, status: "succeeded" }]) });
    const refunds = await c.db.select().from(s.refunds).where(eq(s.refunds.bookingId, b.id));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ providerRefundId: "re_late", status: "succeeded" });
    expect((await booking(b.id)).refundedPence).toBe(1700);
  });
});

describe("C7: undoing a no-show", () => {
  it("is refused when the places were given to someone else", async () => {
    const b = await manual("14:00", 10);
    await markNoShow(c.db, { bookingId: b.id, user: c.owner });
    await manual("14:00", 10);
    await expectCode(markNoShow(c.db, { bookingId: b.id, user: c.owner, undo: true }), "GONE");
    expect((await booking(b.id)).status).toBe("no_show");
    const avail = await getSessionAvailability(c.db, { venue: c.venue, service: c.workshops, from: DAY, to: DAY, now: NOW });
    expect(avail.find((a) => a.sessionId === sessionId("14:00"))!.taken).toBe(10);
  });

  it("is allowed while the places are still free", async () => {
    const b = await manual("14:00", 4);
    await markNoShow(c.db, { bookingId: b.id, user: c.owner });
    await manual("14:00", 6);
    expect((await markNoShow(c.db, { bookingId: b.id, user: c.owner, undo: true })).status).toBe("confirmed");
  });
});

describe("C8: changing counts keeps the prices paid", () => {
  async function setPrice(pence: number) {
    await c.db.update(s.serviceOptions).set({ unitPricePence: pence }).where(eq(s.serviceOptions.id, slime()));
  }

  it("prices only the new place at today's price", async () => {
    const b = await manual("14:00", 2);
    expect(b).toMatchObject({ totalPence: 3400, paidPence: 3400 });
    await setPrice(2000);
    const up = await changeBookingCounts(c.db, { bookingId: b.id, user: c.owner, lines: [{ optionId: slime(), qty: 3 }], addOns: [], now: NOW });
    expect(up.booking).toMatchObject({ places: 3, totalPence: 5400, subtotalPence: 5400, paymentStatus: "owed" });
    expect(up.delta).toBe(2000);
    expect(up.booking.lines.map((l) => [l.qty, l.unitPence, l.totalPence])).toEqual([
      [2, 1700, 3400],
      [1, 2000, 2000],
    ]);
    // Back down to 2 drops the newest place first.
    const down = await changeBookingCounts(c.db, { bookingId: b.id, user: c.owner, lines: [{ optionId: slime(), qty: 2 }], addOns: [], now: NOW });
    expect(down.booking).toMatchObject({ totalPence: 3400, paymentStatus: "paid" });
    expect(down.delta).toBe(0);
  });

  it("keeps the sold unit price going down, and allows an archived option already on the booking", async () => {
    const b = await manual("14:00", 3);
    await setPrice(2000);
    await c.db.update(s.serviceOptions).set({ archivedAt: NOW }).where(eq(s.serviceOptions.id, slime()));
    const down = await changeBookingCounts(c.db, { bookingId: b.id, user: c.owner, lines: [{ optionId: slime(), qty: 1 }], addOns: [], now: NOW });
    expect(down.booking.lines).toEqual([expect.objectContaining({ qty: 1, unitPence: 1700, totalPence: 1700 })]);
    expect(down.booking.totalPence).toBe(1700);
    expect(down.delta).toBe(-3400);
  });

  it("splits quantities over sold price tranches", () => {
    expect(keepSoldPrices(3, 2000, [{ qty: 2, unitPence: 1700 }])).toEqual([
      { qty: 2, unitPence: 1700 },
      { qty: 1, unitPence: 2000 },
    ]);
    expect(keepSoldPrices(1, 2000, [{ qty: 3, unitPence: 1700 }])).toEqual([{ qty: 1, unitPence: 1700 }]);
    expect(keepSoldPrices(4, 1700, [{ qty: 2, unitPence: 1700 }])).toEqual([{ qty: 4, unitPence: 1700 }]);
    expect(keepSoldPrices(2, 2000, [])).toEqual([{ qty: 2, unitPence: 2000 }]);
  });
});

describe("C9: the hold-expiry job", () => {
  it("cancels a pending booking whose hold has already expired", async () => {
    const h = await hold("14:00", 2);
    const co = await checkout(h.id);
    // An earlier run expired the hold but stopped before cancelling the booking.
    await c.db.update(s.holds).set({ status: "expired", expiresAt: NOW }).where(eq(s.holds.id, h.id));
    expect(await remaining("14:00")).toBe(8);
    const summary = await expireHoldsJob(c.db, new Date(NOW.getTime() + 60_000));
    expect(summary.bookingsCancelled).toBe(1);
    expect(await booking(co.bookingId)).toMatchObject({ status: "cancelled", cancelReason: "expired" });
    expect(await remaining("14:00")).toBe(10);
  });

  it("expires the hold and cancels its booking together", async () => {
    const h = await hold("14:00", 2);
    const co = await checkout(h.id);
    const summary = await expireHoldsJob(c.db, new Date(NOW.getTime() + 16 * 60_000));
    expect(summary).toMatchObject({ expired: 1, bookingsCancelled: 1, checkoutsExpired: 1, errors: [] });
    expect((await booking(co.bookingId)).status).toBe("cancelled");
    const [row] = await c.db.select().from(s.holds).where(eq(s.holds.id, h.id));
    expect(row.status).toBe("expired");
  });
});

describe("C12: reminders after a move", () => {
  it("sends a reminder for the new time", async () => {
    const b = await manual("14:00", 1);
    await c.db.update(s.customers).set({ email: "walk@example.com" }).where(eq(s.customers.id, b.customerId));
    await c.db.update(s.bookings).set({ createdAt: NOW }).where(eq(s.bookings.id, b.id));
    const reminders = async () =>
      (await c.db.select().from(s.notifications).where(and(eq(s.notifications.bookingId, b.id), eq(s.notifications.template, "reminder")))).length;

    const first = await remindersJob(c.db, new Date(zonedDateTime(DAY, "14:00").getTime() - 3 * 60 * 60_000));
    expect(first.sent).toBe(1);
    expect(await reminders()).toBe(1);

    await moveBooking(c.db, { bookingId: b.id, user: c.owner, sessionId: sessionId("16:00"), now: NOW });
    const second = await remindersJob(c.db, new Date(zonedDateTime(DAY, "16:00").getTime() - 3 * 60 * 60_000));
    expect(second.sent).toBe(1);
    expect(await reminders()).toBe(2);
    // And still only once per start time.
    const third = await remindersJob(c.db, new Date(zonedDateTime(DAY, "16:00").getTime() - 2 * 60 * 60_000));
    expect(third.sent).toBe(0);
    expect(await reminders()).toBe(2);
  });
});

describe("C14: payment status", () => {
  const base = { totalPence: 3400, paidPence: 3400, refundedPence: 0, paymentMethod: "online_card" as const };
  it("puts what is owed first, then refunds", () => {
    expect(derivePaymentStatus(base)).toBe("paid");
    // Places went up after a partial refund: money is owed.
    expect(derivePaymentStatus({ ...base, totalPence: 5100, refundedPence: 1700 })).toBe("owed");
    // Places went down and the difference was refunded.
    expect(derivePaymentStatus({ ...base, totalPence: 1700, refundedPence: 1700 })).toBe("partially_refunded");
    expect(derivePaymentStatus({ ...base, totalPence: 0, refundedPence: 3400 })).toBe("refunded");
    // A cancelled booking owes nothing.
    expect(derivePaymentStatus({ ...base, refundedPence: 3400, status: "cancelled" })).toBe("refunded");
    expect(derivePaymentStatus({ ...base, paidPence: 0 })).toBe("unpaid");
    expect(derivePaymentStatus({ ...base, paidPence: 0, paymentMethod: "pay_in_store" })).toBe("owed");
  });
});

describe("C15: imported bookings", () => {
  it("records the external reference and an imported payment", async () => {
    const b = await createManualBooking(c.db, {
      user: c.owner,
      venue: c.venue,
      service: c.workshops,
      sessionId: sessionId("14:00"),
      lines: [{ optionId: slime(), qty: 2 }],
      addOns: [],
      customer: { firstName: "Wix", lastName: "Parent", email: "", phone: null },
      payment: { method: "imported", amountPence: 3000 },
      source: "import",
      externalRef: "WX-1",
      sendEmail: false,
      now: NOW,
    });
    expect(b).toMatchObject({ source: "import", externalRef: "WX-1", paymentMethod: "imported", paidPence: 3000, paymentStatus: "owed" });
    const payments = await c.db.select().from(s.payments).where(eq(s.payments.bookingId, b.id));
    expect(payments).toEqual([expect.objectContaining({ provider: "import", method: "imported", amountPence: 3000, status: "succeeded" })]);
  });
});

describe("C16: cancelling a pending booking closes its payment page", () => {
  it("expires the checkout when the customer releases the hold or an admin cancels", async () => {
    const expire = vi.spyOn(DemoPaymentProvider.prototype, "expireCheckout");
    const h = await hold("14:00", 1);
    const co = await checkout(h.id);
    await cancelBooking(c.db, { bookingId: co.bookingId, user: c.owner, reason: "Duplicate", now: NOW });
    expect(expire).toHaveBeenCalledWith(`demo_cs_${co.bookingId}`);
  });
});

describe("S5 and S6: Stripe webhooks", () => {
  function completed(id: string, bookingId: string, object: Record<string, unknown> = {}): WebhookEvent {
    return {
      id,
      type: "checkout.session.completed",
      data: {
        object: { id: `cs_${id}`, payment_status: "paid", payment_intent: `pi_${id}`, amount_total: 3400, currency: "gbp", metadata: { bookingId }, ...object },
      },
    };
  }

  it("forgets an event for an unknown booking so a retry can process it", async () => {
    const event = completed("evt_unknown", "00000000-0000-4000-8000-000000000000");
    expect((await handleStripeEvent(c.db, { venue: c.venue, event })).ignored).toBe("unknown booking");
    const second = await handleStripeEvent(c.db, { venue: c.venue, event });
    expect(second.duplicate).toBeUndefined();
    expect(await c.db.select().from(s.processedWebhookEvents)).toHaveLength(0);
  });

  it("refuses to confirm when the amount is short, missing or in another currency, and alerts the owner", async () => {
    const h = await hold("14:00", 2);
    const co = await checkout(h.id);
    const cases: Record<string, unknown>[] = [{ amount_total: 100 }, { amount_total: null }, { currency: "usd" }];
    for (const [i, extra] of cases.entries()) {
      const res = await handleStripeEvent(c.db, { venue: c.venue, event: completed(`evt_bad_${i}`, co.bookingId, extra) });
      expect(res.ignored).toBe("amount mismatch");
    }
    const pi = await handleStripeEvent(c.db, {
      venue: c.venue,
      event: { id: "evt_pi_bad", type: "payment_intent.succeeded", data: { object: { id: "pi_x", amount_received: 1, currency: "gbp", metadata: { bookingId: co.bookingId } } } },
    });
    expect(pi.ignored).toBe("amount mismatch");

    expect(await booking(co.bookingId)).toMatchObject({ status: "pending", paidPence: 0 });
    const stripePayments = await c.db
      .select()
      .from(s.payments)
      .where(and(eq(s.payments.bookingId, co.bookingId), eq(s.payments.provider, "stripe")));
    expect(stripePayments).toHaveLength(0);
    const alerts = await c.db.select().from(s.notifications).where(eq(s.notifications.template, "owner_payment_mismatch"));
    expect(alerts).toHaveLength(4);

    // The full amount confirms.
    const ok = await handleStripeEvent(c.db, { venue: c.venue, event: completed("evt_good", co.bookingId) });
    expect(ok.action).toBe("confirmed");
  });
});

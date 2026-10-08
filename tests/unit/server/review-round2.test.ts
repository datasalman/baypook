/**
 * Regression tests for the second-round review findings (X2). Each `describe`
 * names its finding number from the brief.
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
import { createHold } from "@/server/holds";
import { startCheckout } from "@/server/checkout";
import { ensureSessions } from "@/server/sessions";
import {
  BookingError,
  cancelBooking,
  changeBookingCounts,
  confirmBookingPaid,
  createManualBooking,
  derivePaymentStatus,
  previewBookingCounts,
  refundBooking,
} from "@/server/bookings";
import { addTimetableException, addTimetableRules, deleteTimetableRule } from "@/server/catalogue-admin";
import { handleStripeEvent, type WebhookEvent } from "@/server/webhooks";
import { expireHoldsJob } from "@/server/jobs";
import { outstanding } from "@/server/reports";
import { paymentLineFor } from "@/server/notifications";
import { DemoPaymentProvider } from "@/providers/payment/demo";
import { editorCatalogue } from "@/app/(admin)/admin/bookings/_lib/catalogue";

const NOW = new Date("2026-10-10T09:00:00Z");
const DAY = "2026-10-24";
const TZ = "Europe/London";

type Ctx = { db: Db; venue: s.Venue; workshops: ServiceWithCatalogue; owner: CurrentUser; sessions: Map<string, string> };
let c: Ctx;

async function sessionsFor(db: Db, venue: s.Venue, service: ServiceWithCatalogue): Promise<Map<string, string>> {
  const avail = await getSessionAvailability(db, { venue, service, from: DAY, to: DAY, now: NOW });
  return new Map(avail.map((a) => [a.startsAt.toISOString(), a.sessionId]));
}

beforeEach(async () => {
  // The admin timetable functions work out "today" from the clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
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
  vi.useRealTimers();
});

const at = (time: string) => zonedDateTime(DAY, time, TZ).toISOString();
const sessionId = (time: string) => c.sessions.get(at(time))!;
const slime = () => c.workshops.options.find((o) => o.name === "Slime Workshop")!.id;
const customer = { firstName: "Amina", lastName: "Khan", email: "amina@example.com", phone: "07700 900123" };

async function hold(time: string, qty: number) {
  const res = await createHold(c.db, {
    venue: c.venue,
    service: c.workshops,
    holdMinutes: 15,
    sessionId: sessionId(time),
    lines: [{ optionId: slime(), qty }],
    addOns: [],
    now: NOW,
  });
  return res.hold;
}

function checkout(holdId: string) {
  return startCheckout(c.db, { holdId, customer, accept: { terms: true, waiver: true }, now: NOW });
}

function manual(time: string, qty: number) {
  return createManualBooking(c.db, {
    user: c.owner,
    venue: c.venue,
    service: c.workshops,
    sessionId: sessionId(time),
    lines: [{ optionId: slime(), qty }],
    addOns: [],
    customer: { firstName: "Walk", lastName: "In", email: "", phone: null },
    payment: { method: "cash" },
    sendEmail: false,
    now: NOW,
  });
}

async function booking(id: string): Promise<s.Booking> {
  const [row] = await c.db.select().from(s.bookings).where(eq(s.bookings.id, id));
  return row;
}

async function session(id: string): Promise<s.Session> {
  const [row] = await c.db.select().from(s.sessions).where(eq(s.sessions.id, id));
  return row;
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await errorOf(p);
  expect(err).toBeInstanceOf(Error);
  expect((err as BookingError).code).toBe(code);
}

async function setSlimePrice(pence: number) {
  await c.db.update(s.serviceOptions).set({ unitPricePence: pence }).where(eq(s.serviceOptions.id, slime()));
}

/** A pending online booking confirmed through a Stripe event (payment intent `pi_<n>`). */
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

describe("1: a 'cancel one time' exception on a session with only a hold", () => {
  it("cancels it, keeps one with a live booking, and reports exactly the kept ones", async () => {
    const h = await hold("14:00", 2);
    await manual("15:00", 1);

    const first = await addTimetableException(c.db, c.owner, c.workshops.id, { date: DAY, kind: "cancel_time", startTime: "14:00" });
    expect(first.keptWithBookings).toBe(0);
    expect(await session(sessionId("14:00"))).toMatchObject({ status: "cancelled", pinned: false });
    const avail = await getSessionAvailability(c.db, { venue: c.venue, service: c.workshops, from: DAY, to: DAY, now: NOW });
    expect(avail.find((a) => a.sessionId === sessionId("14:00"))).toMatchObject({ bookable: false, reason: "cancelled" });
    // The hold's checkout is refused, and its places are let go.
    await expectCode(checkout(h.id), "GONE");
    const [released] = await c.db.select().from(s.holds).where(eq(s.holds.id, h.id));
    expect(released.status).toBe("released");

    const second = await addTimetableException(c.db, c.owner, c.workshops.id, { date: DAY, kind: "cancel_time", startTime: "15:00" });
    expect(second.keptWithBookings).toBe(1);
    expect(await session(sessionId("15:00"))).toMatchObject({ status: "scheduled", pinned: true, source: "manual" });

    // The whole day: only the session with a booking is kept and reported.
    const day = await addTimetableException(c.db, c.owner, c.workshops.id, { date: DAY, kind: "cancel_day" });
    expect(day.keptWithBookings).toBe(1);
  });

  it("returns the kept sessions from ensureSessions", async () => {
    await manual("15:00", 1);
    await c.db.insert(s.timetableExceptions).values({ serviceId: c.workshops.id, date: DAY, startTime: "15:00", kind: "cancel" });
    const r = await ensureSessions(c.db, c.workshops, c.venue, DAY, DAY, TZ);
    expect(r.keptScheduled).toEqual([sessionId("15:00")]);
  });
});

describe("2: leftovers come back when the rules produce them again", () => {
  it("restores a cancelled leftover after its rule is deleted and added again", async () => {
    const b = await manual("14:00", 1);
    await cancelBooking(c.db, { bookingId: b.id, user: c.owner, reason: "Changed plans", now: NOW });
    const weekday = new Date(`${DAY}T12:00:00Z`).getUTCDay();
    const [rule] = await c.db
      .select()
      .from(s.timetableRules)
      .where(and(eq(s.timetableRules.serviceId, c.workshops.id), eq(s.timetableRules.startTime, "14:00"), eq(s.timetableRules.weekday, weekday)));

    await deleteTimetableRule(c.db, c.owner, rule.id);
    // Kept (a cancelled booking refers to it) but cancelled and not pinned.
    expect(await session(sessionId("14:00"))).toMatchObject({ status: "cancelled", pinned: false, source: "rule" });

    await addTimetableRules(c.db, c.owner, c.workshops.id, { weekdays: [weekday], startTime: "14:00", capacity: rule.capacity });
    expect(await session(sessionId("14:00"))).toMatchObject({ status: "scheduled", pinned: false, source: "rule" });
  });

  it("also restores a leftover that older versions pinned as a cancelled manual row", async () => {
    await c.db.update(s.sessions).set({ status: "cancelled", pinned: true, source: "manual" }).where(eq(s.sessions.id, sessionId("14:00")));
    await ensureSessions(c.db, c.workshops, c.venue, DAY, DAY, TZ);
    expect(await session(sessionId("14:00"))).toMatchObject({ status: "scheduled", pinned: false, source: "rule" });
  });

  it("does not undo an admin's own cancellation of one session", async () => {
    await c.db.update(s.sessions).set({ status: "cancelled", pinned: true }).where(eq(s.sessions.id, sessionId("14:00")));
    await ensureSessions(c.db, c.workshops, c.venue, DAY, DAY, TZ);
    expect(await session(sessionId("14:00"))).toMatchObject({ status: "cancelled", pinned: true });
  });
});

describe("3: the change-counts preview", () => {
  it("prices exactly as saving does, keeping prices paid", async () => {
    const b = await manual("14:00", 2);
    await setSlimePrice(2000);
    const lines = [{ optionId: slime(), qty: 3 }];
    const preview = await previewBookingCounts(c.db, { bookingId: b.id, user: c.owner, lines, addOns: [] });
    expect(preview).toMatchObject({ totalPence: 5400, places: 3, delta: 2000 });
    expect(preview.lines.map((l) => [l.qty, l.unitPence])).toEqual([
      [2, 1700],
      [1, 2000],
    ]);
    // Nothing was saved by the preview.
    expect((await booking(b.id)).totalPence).toBe(3400);
    const saved = await changeBookingCounts(c.db, { bookingId: b.id, user: c.owner, lines, addOns: [], now: NOW });
    expect(saved.booking.totalPence).toBe(preview.totalPence);
    expect(saved.booking.lines).toEqual(preview.lines);
    expect(saved.delta).toBe(preview.delta);
  });

  it("keeps archived items already on the booking in the editor and the preview", async () => {
    const b = await manual("14:00", 3);
    await c.db.update(s.serviceOptions).set({ archivedAt: NOW }).where(eq(s.serviceOptions.id, slime()));
    const svc = (await getService(c.db, c.workshops.id, { includeArchived: true }))!;
    expect(editorCatalogue(svc, c.venue).options.map((o) => o.id)).not.toContain(slime());
    expect(editorCatalogue(svc, c.venue, { optionIds: [slime()] }).options.map((o) => o.id)).toContain(slime());

    const preview = await previewBookingCounts(c.db, { bookingId: b.id, user: c.owner, lines: [{ optionId: slime(), qty: 1 }], addOns: [] });
    expect(preview).toMatchObject({ totalPence: 1700, delta: -3400 });
  });
});

describe("4: owed means total − paid > 0", () => {
  it("derives the payment status from total − paid", () => {
    const base = { totalPence: 3400, paidPence: 3400, refundedPence: 0, paymentMethod: "online_card" as const };
    // A goodwill partial refund, places unchanged.
    expect(derivePaymentStatus({ ...base, refundedPence: 1000 })).toBe("partially_refunded");
    // Places went up after a partial refund.
    expect(derivePaymentStatus({ ...base, totalPence: 5100, refundedPence: 1000 })).toBe("owed");
    expect(derivePaymentStatus({ ...base, totalPence: 5100, refundedPence: 1000, status: "cancelled" })).toBe("partially_refunded");
  });

  it("agrees across the booking, the Outstanding report and the payment line", async () => {
    const b = await manual("14:00", 2);
    await refundBooking(c.db, { bookingId: b.id, user: c.owner, amountPence: 1000, reason: "Goodwill" });
    const afterRefund = await booking(b.id);
    expect(afterRefund).toMatchObject({ paymentStatus: "partially_refunded", refundedPence: 1000 });
    expect((await outstanding(c.db, { venueIds: [c.venue.id] })).map((x) => x.id)).not.toContain(b.id);
    expect(paymentLineFor(afterRefund)).toBe("Paid in store");

    const up = await changeBookingCounts(c.db, { bookingId: b.id, user: c.owner, lines: [{ optionId: slime(), qty: 3 }], addOns: [], now: NOW });
    expect(up.booking).toMatchObject({ totalPence: 5100, paymentStatus: "owed" });
    expect(up.delta).toBe(1700);
    const owed = await outstanding(c.db, { venueIds: [c.venue.id] });
    expect(owed.find((x) => x.id === b.id)?.owedPence).toBe(1700);
    expect(paymentLineFor(up.booking)).toBe("Part paid, £17.00 to pay in store");

    // Down to one place: paid 3400, 1000 already given back, so 700 more to refund.
    const down = await changeBookingCounts(c.db, { bookingId: b.id, user: c.owner, lines: [{ optionId: slime(), qty: 1 }], addOns: [], now: NOW });
    expect(down.booking.paymentStatus).toBe("partially_refunded");
    expect(down.delta).toBe(-700);
  });
});

describe("5: changing a party's extras", () => {
  it("keeps the sold package's children and price, and counts places from the kept lines", async () => {
    const party = (await getServiceBySlug(c.db, c.venue.id, "slime-party"))!;
    const pkg = party.options[0];
    const extra = party.addOns.find((a) => a.perChild)!;
    const b = await createManualBooking(c.db, {
      user: c.owner,
      venue: c.venue,
      service: party,
      startsAt: zonedDateTime(DAY, "10:00", TZ),
      lines: [{ optionId: pkg.id, qty: 1 }],
      addOns: [{ addOnId: extra.id, qty: 2 }],
      customer: { firstName: "Sarah", lastName: "Jones", email: "", phone: null },
      birthdayChild: { firstName: "Mia", age: 7 },
      payment: { method: "cash" },
      sendEmail: false,
      now: NOW,
    });
    expect(b).toMatchObject({ places: 12, totalPence: 20000 + 2 * 1600 });

    await c.db.update(s.serviceOptions).set({ includedChildren: 12, unitPricePence: 25000 }).where(eq(s.serviceOptions.id, pkg.id));
    const r = await changeBookingCounts(c.db, {
      bookingId: b.id,
      user: c.owner,
      lines: [{ optionId: pkg.id, qty: 1 }],
      addOns: [{ addOnId: extra.id, qty: 3 }],
      now: NOW,
    });
    expect(r.booking.lines).toEqual([expect.objectContaining({ optionId: pkg.id, qty: 1, unitPence: 20000, includedChildren: 10 })]);
    expect(r.booking).toMatchObject({ places: 13, totalPence: 20000 + 3 * 1600 });
  });
});

describe("6: a checkout superseded while its payment page was being made", () => {
  it("closes that payment page and records only the newer one", async () => {
    const h = await hold("14:00", 2);
    const original = DemoPaymentProvider.prototype.createCheckout;
    const expire = vi.spyOn(DemoPaymentProvider.prototype, "expireCheckout");
    let newer: Awaited<ReturnType<typeof checkout>> | null = null;
    let started = false;
    vi.spyOn(DemoPaymentProvider.prototype, "createCheckout").mockImplementation(async function (this: DemoPaymentProvider, input) {
      if (!started) {
        started = true;
        // The customer presses Pay again before the first payment page comes back.
        newer = await checkout(h.id);
      }
      return original.call(this, input);
    });

    const err = await errorOf(checkout(h.id));
    expect(err).toBeInstanceOf(BookingError);
    expect((err as BookingError).code).toBe("STATE");
    expect(newer).not.toBeNull();
    const newerId = newer!.bookingId;

    const [row] = await c.db.select().from(s.holds).where(eq(s.holds.id, h.id));
    expect(row).toMatchObject({ bookingId: newerId, checkoutId: `demo_cs_${newerId}`, status: "active" });
    const pending = await c.db.select().from(s.payments).where(eq(s.payments.status, "pending"));
    expect(pending.map((p) => p.bookingId)).toEqual([newerId]);
    const older = await c.db
      .select()
      .from(s.bookings)
      .where(and(eq(s.bookings.holdId, h.id), eq(s.bookings.status, "cancelled")));
    expect(older).toHaveLength(1);
    expect(expire).toHaveBeenCalledWith(`demo_cs_${older[0].id}`);
  });

  it("has the expiry job close a pending booking's own payment page as well as the hold's", async () => {
    const h = await hold("14:00", 2);
    const co = await checkout(h.id);
    // A payment page recorded on the booking but not (or no longer) on the hold.
    await c.db.update(s.holds).set({ checkoutId: null }).where(eq(s.holds.id, h.id));
    const expire = vi.spyOn(DemoPaymentProvider.prototype, "expireCheckout");
    const summary = await expireHoldsJob(c.db, new Date(NOW.getTime() + 20 * 60_000));
    expect(summary.bookingsCancelled).toBe(1);
    expect(expire).toHaveBeenCalledWith(`demo_cs_${co.bookingId}`);
  });
});

describe("8: the payment provider cannot open a payment page", () => {
  it("cancels the booking but keeps the places held so trying again works", async () => {
    const h = await hold("14:00", 2);
    vi.spyOn(DemoPaymentProvider.prototype, "createCheckout").mockRejectedValueOnce(new Error("Stripe is down"));
    const err = await errorOf(checkout(h.id));
    expect(err).toBeInstanceOf(BookingError);
    expect(err).toMatchObject({ code: "UNAVAILABLE" });
    expect((err as Error).message).toContain("still held");

    const [row] = await c.db.select().from(s.holds).where(eq(s.holds.id, h.id));
    expect(row).toMatchObject({ status: "active", bookingId: null, checkoutId: null });
    const cancelled = await c.db.select().from(s.bookings).where(eq(s.bookings.holdId, h.id));
    expect(cancelled.map((b) => b.status)).toEqual(["cancelled"]);
    // The hold keeps its places while nobody owns it.
    const avail = await getSessionAvailability(c.db, { venue: c.venue, service: c.workshops, from: DAY, to: DAY, now: NOW });
    expect(avail.find((a) => a.sessionId === sessionId("14:00"))!.remaining).toBe(8);

    const again = await checkout(h.id);
    expect((await booking(again.bookingId)).status).toBe("pending");
  });
});

describe("9: a booking reinstated by a late payment", () => {
  it("takes its room from its session", async () => {
    const h = await hold("14:00", 2);
    const co = await checkout(h.id);
    await expireHoldsJob(c.db, new Date(NOW.getTime() + 20 * 60_000));
    expect((await booking(co.bookingId)).status).toBe("cancelled");

    const [newRoom] = await c.db.insert(s.rooms).values({ venueId: c.venue.id, name: "Back room", sortOrder: 5 }).returning();
    await c.db.update(s.sessions).set({ roomId: newRoom.id, pinned: true }).where(eq(s.sessions.id, sessionId("14:00")));

    const res = await confirmBookingPaid(c.db, {
      bookingId: co.bookingId,
      payment: { provider: "demo", providerCheckoutId: `demo_cs_${co.bookingId}`, amountPence: 3400, currency: "gbp" },
      now: NOW,
    });
    expect(res.booking).toMatchObject({ status: "confirmed", roomId: newRoom.id });
  });
});

describe("10: refund.updated and charge.refund.updated", () => {
  function refundEvent(id: string, type: string, refund: Record<string, unknown>): WebhookEvent {
    return { id, type, data: { object: { object: "refund", currency: "gbp", ...refund } } };
  }
  const refundEmails = async (bookingId: string) =>
    c.db
      .select()
      .from(s.notifications)
      .where(and(eq(s.notifications.bookingId, bookingId), eq(s.notifications.template, "refund")));

  it("settles a pending card refund by its provider id", async () => {
    const b = await stripePaid("14:00", 2, 1);
    const providerRefund = vi.spyOn(DemoPaymentProvider.prototype, "refund");
    providerRefund.mockResolvedValueOnce({ providerRefundId: "re_p1", status: "pending" });
    await refundBooking(c.db, { bookingId: b.id, user: c.owner, amountPence: 1700, reason: "One child ill" });
    expect(await booking(b.id)).toMatchObject({ refundedPence: 1700, paymentStatus: "partially_refunded" });
    expect(await refundEmails(b.id)).toHaveLength(0);

    const ok = await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_ru1", "refund.updated", { id: "re_p1", amount: 1700, status: "succeeded", charge: "ch_1", payment_intent: "pi_1" }),
    });
    expect(ok).toMatchObject({ bookingId: b.id, action: "refund succeeded" });
    const [r1] = await c.db.select().from(s.refunds).where(eq(s.refunds.providerRefundId, "re_p1"));
    expect(r1.status).toBe("succeeded");
    expect(await refundEmails(b.id)).toHaveLength(1);
    // The same event again is a duplicate.
    expect(
      await handleStripeEvent(c.db, {
        venue: c.venue,
        event: refundEvent("evt_ru1", "refund.updated", { id: "re_p1", amount: 1700, status: "succeeded" }),
      }),
    ).toMatchObject({ duplicate: true });

    // A second pending refund that then fails gives the amount back.
    providerRefund.mockResolvedValueOnce({ providerRefundId: "re_p2", status: "pending" });
    await refundBooking(c.db, { bookingId: b.id, user: c.owner, amountPence: 500, reason: "Goodwill" });
    expect((await booking(b.id)).refundedPence).toBe(2200);
    await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_ru2", "charge.refund.updated", { id: "re_p2", amount: 500, status: "failed", charge: "ch_1", payment_intent: "pi_1" }),
    });
    const [r2] = await c.db.select().from(s.refunds).where(eq(s.refunds.providerRefundId, "re_p2"));
    expect(r2.status).toBe("failed");
    expect((await booking(b.id)).refundedPence).toBe(1700);
  });

  it("records a refund it has not seen yet against the payment", async () => {
    const b = await stripePaid("14:00", 2, 2);
    await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_ru3", "refund.updated", { id: "re_dash", amount: 500, status: "succeeded", payment_intent: "pi_2" }),
    });
    expect(await booking(b.id)).toMatchObject({ refundedPence: 500, paymentStatus: "partially_refunded" });
    // An event for a payment nobody knows is forgotten so a retry can place it.
    const unknown = await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_ru4", "refund.updated", { id: "re_x", amount: 100, status: "succeeded", payment_intent: "pi_nope" }),
    });
    expect(unknown.ignored).toBe("unknown payment");
    const seen = await c.db.select().from(s.processedWebhookEvents).where(eq(s.processedWebhookEvents.id, "evt_ru4"));
    expect(seen).toHaveLength(0);
  });
});

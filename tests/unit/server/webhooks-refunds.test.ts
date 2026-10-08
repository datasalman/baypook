/**
 * Stripe refund reconciliation (X4): refunds are matched strictly by Stripe's
 * refund id, `charge.refunded` only triggers a re-list through `listRefunds`,
 * and a refund counts as gone through only when Stripe says `succeeded`.
 */
process.env.BAYPOOK_MODE = "demo";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { refundBooking } from "@/server/bookings";
import { handleStripeEvent, type ListRefunds, type ProviderRefund, type WebhookEvent } from "@/server/webhooks";
import { DemoPaymentProvider } from "@/providers/payment/demo";

const NOW = new Date("2026-10-10T09:00:00Z");
const DAY = "2026-10-24";

type Ctx = { db: Db; venue: s.Venue; workshops: ServiceWithCatalogue; owner: CurrentUser; sessions: Map<string, string> };
let c: Ctx;

beforeEach(async () => {
  const db = await createTestDb({ seed: true });
  const venue = (await getVenueBySlug(db, "south-woodford"))!;
  const workshops = (await getServiceBySlug(db, venue.id, "classic-workshops"))!;
  const [ownerRow] = await db.select().from(s.users).where(eq(s.users.isOwner, true));
  const avail = await getSessionAvailability(db, { venue, service: workshops, from: DAY, to: DAY, now: NOW });
  c = {
    db,
    venue,
    workshops,
    sessions: new Map(avail.map((a) => [a.startsAt.toISOString(), a.sessionId])),
    owner: { id: ownerRow.id, email: ownerRow.email, name: ownerRow.name, isOwner: true, venues: [] },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const slime = () => c.workshops.options.find((o) => o.name === "Slime Workshop")!.id;

/** A pending online booking (not yet paid). */
async function pendingBooking(qty: number): Promise<string> {
  const { hold } = await createHold(c.db, {
    venue: c.venue,
    service: c.workshops,
    holdMinutes: 15,
    sessionId: c.sessions.get(zonedDateTime(DAY, "14:00").toISOString())!,
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
  return co.bookingId;
}

/** A booking paid through Stripe Checkout with payment intent `pi_1` (charge `ch_1`). */
async function stripePaid(qty: number): Promise<string> {
  const bookingId = await pendingBooking(qty);
  const res = await handleStripeEvent(c.db, {
    venue: c.venue,
    event: {
      id: "evt_paid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          payment_status: "paid",
          payment_intent: "pi_1",
          amount_total: qty * 1700,
          currency: "gbp",
          metadata: { bookingId },
        },
      },
    },
  });
  expect(res.action).toBe("confirmed");
  return bookingId;
}

/** Stripe's side: the refunds on charge `ch_1`, as `refunds.list` would return them. */
function stripeRefunds() {
  const refunds: ProviderRefund[] = [];
  const listRefunds = vi.fn<ListRefunds>(async (chargeId) => refunds.filter((r) => r.charge === chargeId).map((r) => ({ ...r })));
  const put = (r: { id: string; amount: number; status: string; created?: number }) => {
    const full: ProviderRefund = { charge: "ch_1", payment_intent: "pi_1", created: refunds.length + 1, ...r };
    const i = refunds.findIndex((x) => x.id === r.id);
    if (i >= 0) refunds[i] = { ...refunds[i], ...r };
    else refunds.push(full);
  };
  return { refunds, listRefunds, put };
}

/** A snapshot `charge.refunded` event: the charge carries no refunds list, only the total. */
function chargeRefunded(id: string, amountRefunded: number): WebhookEvent {
  return {
    id,
    type: "charge.refunded",
    data: { object: { object: "charge", id: "ch_1", payment_intent: "pi_1", amount_refunded: amountRefunded, refunded: false } },
  };
}

function refundEvent(id: string, type: string, refund: { id: string; amount: number; status: string }): WebhookEvent {
  return { id, type, data: { object: { object: "refund", charge: "ch_1", payment_intent: "pi_1", currency: "gbp", ...refund } } };
}

async function booking(id: string): Promise<s.Booking> {
  const [row] = await c.db.select().from(s.bookings).where(eq(s.bookings.id, id));
  return row;
}

async function refundRows(bookingId: string): Promise<s.Refund[]> {
  return c.db.select().from(s.refunds).where(eq(s.refunds.bookingId, bookingId));
}

async function refundEmails(bookingId: string): Promise<s.Notification[]> {
  return c.db
    .select()
    .from(s.notifications)
    .where(and(eq(s.notifications.bookingId, bookingId), eq(s.notifications.template, "refund")));
}

describe("a refund made in the Stripe dashboard", () => {
  it("records one row and sends one email when charge.refunded is followed by refund.updated", async () => {
    const bookingId = await stripePaid(2);
    const stripe = stripeRefunds();
    stripe.put({ id: "re_dash", amount: 500, status: "succeeded" });

    const first = await handleStripeEvent(c.db, { venue: c.venue, event: chargeRefunded("evt_cr1", 500), listRefunds: stripe.listRefunds });
    expect(first).toMatchObject({ bookingId, action: "refunds added 1, settled 0" });
    expect(stripe.listRefunds).toHaveBeenCalledWith("ch_1");

    const second = await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_ru1", "refund.updated", { id: "re_dash", amount: 500, status: "succeeded" }),
      listRefunds: stripe.listRefunds,
    });
    expect(second.ignored).toBe("refund is succeeded");
    // refund.created arriving late changes nothing either.
    await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_rc1", "refund.created", { id: "re_dash", amount: 500, status: "pending" }),
      listRefunds: stripe.listRefunds,
    });

    const rows = await refundRows(bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerRefundId: "re_dash", amountPence: 500, status: "succeeded", createdBy: null });
    expect(await booking(bookingId)).toMatchObject({ refundedPence: 500, paymentStatus: "partially_refunded" });
    expect(await refundEmails(bookingId)).toHaveLength(1);
    // The charge id is remembered on the payment.
    const [payment] = await c.db.select().from(s.payments).where(and(eq(s.payments.bookingId, bookingId), eq(s.payments.provider, "stripe")));
    expect(payment.providerChargeId).toBe("ch_1");
  });

  it("never invents a refund id from the charge total", async () => {
    const bookingId = await stripePaid(2);
    const stripe = stripeRefunds();
    // Stripe has not listed the refund yet (or lists nothing): nothing is recorded.
    const res = await handleStripeEvent(c.db, { venue: c.venue, event: chargeRefunded("evt_cr2", 1000), listRefunds: stripe.listRefunds });
    expect(res.action).toBe("refunds added 0, settled 0");
    expect(await refundRows(bookingId)).toHaveLength(0);
    expect((await booking(bookingId)).refundedPence).toBe(0);
  });

  it("records a dashboard refund that is still pending without emailing, then emails once it succeeds", async () => {
    const bookingId = await stripePaid(2);
    const stripe = stripeRefunds();
    stripe.put({ id: "re_slow", amount: 1700, status: "pending" });
    await handleStripeEvent(c.db, { venue: c.venue, event: chargeRefunded("evt_cr3", 1700), listRefunds: stripe.listRefunds });
    expect((await refundRows(bookingId))[0]).toMatchObject({ providerRefundId: "re_slow", status: "pending" });
    expect(await refundEmails(bookingId)).toHaveLength(0);

    stripe.put({ id: "re_slow", amount: 1700, status: "succeeded" });
    const res = await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_ru3", "refund.updated", { id: "re_slow", amount: 1700, status: "succeeded" }),
      listRefunds: stripe.listRefunds,
    });
    expect(res.action).toBe("refund succeeded");
    expect(await refundRows(bookingId)).toHaveLength(1);
    expect(await refundEmails(bookingId)).toHaveLength(1);
  });
});

describe("a refund made from BayPook", () => {
  it("stays pending until Stripe reports it succeeded", async () => {
    const bookingId = await stripePaid(2);
    const stripe = stripeRefunds();
    stripe.put({ id: "re_ours", amount: 1700, status: "pending" });
    vi.spyOn(DemoPaymentProvider.prototype, "refund").mockResolvedValueOnce({ providerRefundId: "re_ours", status: "pending" });
    const refund = await refundBooking(c.db, { bookingId, user: c.owner, amountPence: 1700, reason: "One child ill" });
    expect(refund.status).toBe("pending");

    // charge.refunded arrives while Stripe still holds the refund as pending.
    await handleStripeEvent(c.db, { venue: c.venue, event: chargeRefunded("evt_o1", 1700), listRefunds: stripe.listRefunds });
    let rows = await refundRows(bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: refund.id, providerRefundId: "re_ours", status: "pending" });
    expect(await refundEmails(bookingId)).toHaveLength(0);

    // A stale snapshot saying succeeded does not win over Stripe's current state.
    await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_o2", "refund.updated", { id: "re_ours", amount: 1700, status: "succeeded" }),
      listRefunds: stripe.listRefunds,
    });
    expect((await refundRows(bookingId))[0].status).toBe("pending");

    stripe.put({ id: "re_ours", amount: 1700, status: "succeeded" });
    await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_o3", "refund.updated", { id: "re_ours", amount: 1700, status: "succeeded" }),
      listRefunds: stripe.listRefunds,
    });
    rows = await refundRows(bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("succeeded");
    expect(await refundEmails(bookingId)).toHaveLength(1);
    // A later charge.refunded changes nothing.
    await handleStripeEvent(c.db, { venue: c.venue, event: chargeRefunded("evt_o4", 1700), listRefunds: stripe.listRefunds });
    expect(await refundRows(bookingId)).toHaveLength(1);
    expect(await refundEmails(bookingId)).toHaveLength(1);
  });

  it("gives a waiting refund (no Stripe id yet) Stripe's id and status, not succeeded", async () => {
    const bookingId = await stripePaid(2);
    const [payment] = await c.db.select().from(s.payments).where(and(eq(s.payments.bookingId, bookingId), eq(s.payments.provider, "stripe")));
    // What refundBooking's reservation leaves while it waits for Stripe's reply.
    const [waiting] = await c.db
      .insert(s.refunds)
      .values({ paymentId: payment.id, bookingId, amountPence: 1700, reason: "x", status: "pending" })
      .returning();
    await c.db.update(s.bookings).set({ refundedPence: 1700 }).where(eq(s.bookings.id, bookingId));

    const stripe = stripeRefunds();
    stripe.put({ id: "re_race", amount: 1700, status: "pending" });
    await handleStripeEvent(c.db, { venue: c.venue, event: chargeRefunded("evt_w1", 1700), listRefunds: stripe.listRefunds });
    const rows = await refundRows(bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: waiting.id, providerRefundId: "re_race", status: "pending" });
    expect(await refundEmails(bookingId)).toHaveLength(0);
  });

  it("matches two waiting refunds of the same amount to two Stripe refunds", async () => {
    const bookingId = await stripePaid(2);
    const [payment] = await c.db.select().from(s.payments).where(and(eq(s.payments.bookingId, bookingId), eq(s.payments.provider, "stripe")));
    await c.db.insert(s.refunds).values([
      { paymentId: payment.id, bookingId, amountPence: 500, reason: "a", status: "pending" },
      { paymentId: payment.id, bookingId, amountPence: 500, reason: "b", status: "pending" },
    ]);
    await c.db.update(s.bookings).set({ refundedPence: 1000 }).where(eq(s.bookings.id, bookingId));

    const stripe = stripeRefunds();
    stripe.put({ id: "re_a", amount: 500, status: "succeeded" });
    stripe.put({ id: "re_b", amount: 500, status: "pending" });
    const res = await handleStripeEvent(c.db, { venue: c.venue, event: chargeRefunded("evt_t1", 500), listRefunds: stripe.listRefunds });
    expect(res.action).toBe("refunds added 0, settled 2");
    const rows = await refundRows(bookingId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.providerRefundId, r.status]).sort()).toEqual([
      ["re_a", "succeeded"],
      ["re_b", "pending"],
    ]);
    expect((await booking(bookingId)).refundedPence).toBe(1000);
  });

  it("reverses a refund when refund.failed arrives", async () => {
    const bookingId = await stripePaid(2);
    const stripe = stripeRefunds();
    stripe.put({ id: "re_fail", amount: 1700, status: "pending" });
    vi.spyOn(DemoPaymentProvider.prototype, "refund").mockResolvedValueOnce({ providerRefundId: "re_fail", status: "pending" });
    await refundBooking(c.db, { bookingId, user: c.owner, amountPence: 1700, reason: "Goodwill" });
    expect(await booking(bookingId)).toMatchObject({ refundedPence: 1700, paymentStatus: "partially_refunded" });

    stripe.put({ id: "re_fail", amount: 1700, status: "failed" });
    const res = await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_f1", "refund.failed", { id: "re_fail", amount: 1700, status: "failed" }),
      listRefunds: stripe.listRefunds,
    });
    expect(res).toMatchObject({ bookingId, action: "refund failed" });
    expect((await refundRows(bookingId))[0].status).toBe("failed");
    expect(await booking(bookingId)).toMatchObject({ refundedPence: 0, paymentStatus: "paid" });
    const [payment] = await c.db.select().from(s.payments).where(and(eq(s.payments.bookingId, bookingId), eq(s.payments.provider, "stripe")));
    expect(payment.status).toBe("succeeded");
    expect(await refundEmails(bookingId)).toHaveLength(0);
  });
});

describe("without listRefunds (demo mode)", () => {
  it("ignores charge.refunded and reconciles refund.* events from the event's refund", async () => {
    const bookingId = await stripePaid(2);
    const ignored = await handleStripeEvent(c.db, { venue: c.venue, event: chargeRefunded("evt_d1", 500) });
    expect(ignored.ignored).toBe("no refund list");
    expect(await refundRows(bookingId)).toHaveLength(0);
    // Ignored on purpose, so it is not forgotten for a retry.
    expect(await c.db.select().from(s.processedWebhookEvents).where(eq(s.processedWebhookEvents.id, "evt_d1"))).toHaveLength(1);

    const created = await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_d2", "refund.created", { id: "re_demo", amount: 500, status: "pending" }),
    });
    expect(created.action).toBe("refund added");
    expect(await refundEmails(bookingId)).toHaveLength(0);

    const updated = await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_d3", "refund.updated", { id: "re_demo", amount: 500, status: "succeeded" }),
    });
    expect(updated.action).toBe("refund succeeded");
    // An out-of-order pending snapshot does not move it back.
    await handleStripeEvent(c.db, {
      venue: c.venue,
      event: refundEvent("evt_d4", "refund.created", { id: "re_demo", amount: 500, status: "pending" }),
    });
    const rows = await refundRows(bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerRefundId: "re_demo", status: "succeeded" });
    expect(await refundEmails(bookingId)).toHaveLength(1);
  });
});

describe("delayed payment methods", () => {
  it("frees the places when an async payment fails", async () => {
    const bookingId = await pendingBooking(1);
    const res = await handleStripeEvent(c.db, {
      venue: c.venue,
      event: {
        id: "evt_af1",
        type: "checkout.session.async_payment_failed",
        data: { object: { id: "cs_af", payment_status: "unpaid", metadata: { bookingId } } },
      },
    });
    expect(res).toMatchObject({ bookingId, action: "cancelled" });
    expect(await booking(bookingId)).toMatchObject({ status: "cancelled", cancelReason: "declined" });
  });
});

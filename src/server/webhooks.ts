/**
 * Stripe webhook handling (one endpoint per venue; the route verifies the signature).
 *
 * Idempotent: each event id is recorded in `processed_webhook_events` first and a
 * repeat is ignored. If handling fails the record is removed so Stripe's retry is
 * processed. Bookings are confirmed only here (and by the demo checkout), never
 * from the customer's return URL.
 *
 * The event objects are read structurally (only the fields used below), so the
 * handler does not depend on the Stripe SDK's type layout or API version.
 */
import { and, asc, eq, inArray, or, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { fmtPence } from "@/core/time";
import { env } from "@/lib/env";
import { escapeHtml, wrapHtml } from "@/providers/email/render";
import { audit } from "./audit";
import { cancelPendingBooking, confirmBookingPaid, findBookingIdByCheckout, recordProviderRefund } from "./bookings";
import { adminBookingUrl, brandFor, sendRawEmail } from "./notifications";
import { getOrganisation } from "./org";

/** The parts of a Stripe event BayPook reads. `Stripe.Event` is assignable to this. */
export type WebhookEvent = { id: string; type: string; data: { object: unknown } };

export type WebhookResult = {
  type: string;
  duplicate?: boolean;
  ignored?: boolean | string;
  bookingId?: string | null;
  action?: string;
};

// ---------- tiny structural readers ----------

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null ? (v as Obj) : {};
}
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
/** A Stripe "expandable" field: either the id string or the expanded object with `id`. */
function idOf(v: unknown): string | null {
  return str(v) ?? str(obj(v).id);
}
function metadataBookingId(v: unknown): string | null {
  return str(obj(obj(v).metadata).bookingId);
}

// ---------- entry point ----------

export async function handleStripeEvent(
  db: DbOrTx,
  input: { venue: Pick<s.Venue, "id" | "slug">; event: WebhookEvent },
): Promise<WebhookResult> {
  const { venue, event } = input;
  const inserted = await db
    .insert(s.processedWebhookEvents)
    .values({ id: event.id, venueId: venue.id, type: event.type })
    .onConflictDoNothing()
    .returning({ id: s.processedWebhookEvents.id });
  if (inserted.length === 0) return { type: event.type, duplicate: true };

  try {
    return await dispatch(db, venue, event);
  } catch (e) {
    // Let Stripe retry: forget that we saw this event.
    await db.delete(s.processedWebhookEvents).where(eq(s.processedWebhookEvents.id, event.id));
    throw e;
  }
}

async function dispatch(db: DbOrTx, venue: Pick<s.Venue, "id" | "slug">, event: WebhookEvent): Promise<WebhookResult> {
  const o = obj(event.data?.object);
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return checkoutCompleted(db, venue, event.type, o);
    case "payment_intent.succeeded":
      return paymentIntentSucceeded(db, venue, event.type, o);
    case "checkout.session.expired":
      return checkoutExpired(db, venue, event.type, o);
    case "charge.refunded":
      return chargeRefunded(db, venue, event.type, o);
    case "charge.dispute.created":
      return disputeCreated(db, venue, event.type, o);
    default:
      return { type: event.type, ignored: true };
  }
}

async function bookingInVenue(db: DbOrTx, bookingId: string | null, venueId: string): Promise<s.Booking | null> {
  if (!bookingId) return null;
  const [b] = await db.select().from(s.bookings).where(eq(s.bookings.id, bookingId)).limit(1);
  return b && b.venueId === venueId ? b : null;
}

// ---------- payment succeeded ----------

async function checkoutCompleted(db: DbOrTx, venue: Pick<s.Venue, "id">, type: string, session: Obj): Promise<WebhookResult> {
  if (session.payment_status !== "paid") return { type, ignored: "unpaid" };
  const checkoutId = str(session.id);
  let bookingId = metadataBookingId(session);
  if (!bookingId && checkoutId) bookingId = await findBookingIdByCheckout(db, checkoutId);
  const booking = await bookingInVenue(db, bookingId, venue.id);
  if (!booking) return { type, ignored: "unknown booking", bookingId };
  const res = await confirmBookingPaid(db, {
    bookingId: booking.id,
    payment: {
      provider: "stripe",
      providerCheckoutId: checkoutId,
      providerPaymentIntentId: idOf(session.payment_intent),
      amountPence: num(session.amount_total) ?? booking.totalPence,
      currency: str(session.currency) ?? "gbp",
    },
  });
  return { type, bookingId: booking.id, action: res.alreadyConfirmed ? "already_confirmed" : "confirmed" };
}

async function paymentIntentSucceeded(db: DbOrTx, venue: Pick<s.Venue, "id">, type: string, pi: Obj): Promise<WebhookResult> {
  const intentId = str(pi.id);
  let bookingId: string | null = null;
  if (intentId) {
    const [p] = await db
      .select({ bookingId: s.payments.bookingId })
      .from(s.payments)
      .where(eq(s.payments.providerPaymentIntentId, intentId))
      .limit(1);
    bookingId = p?.bookingId ?? null;
  }
  bookingId ??= metadataBookingId(pi);
  const booking = await bookingInVenue(db, bookingId, venue.id);
  if (!booking) return { type, ignored: "unknown booking", bookingId };
  const res = await confirmBookingPaid(db, {
    bookingId: booking.id,
    payment: {
      provider: "stripe",
      providerPaymentIntentId: intentId,
      providerChargeId: idOf(pi.latest_charge),
      amountPence: num(pi.amount_received) ?? num(pi.amount) ?? booking.totalPence,
      currency: str(pi.currency) ?? "gbp",
    },
  });
  return { type, bookingId: booking.id, action: res.alreadyConfirmed ? "already_confirmed" : "confirmed" };
}

// ---------- checkout expired ----------

async function checkoutExpired(db: DbOrTx, venue: Pick<s.Venue, "id">, type: string, session: Obj): Promise<WebhookResult> {
  const checkoutId = str(session.id);
  let bookingId = metadataBookingId(session);
  if (!bookingId && checkoutId) bookingId = await findBookingIdByCheckout(db, checkoutId);
  const booking = await bookingInVenue(db, bookingId, venue.id);
  if (!booking) return { type, ignored: "unknown booking", bookingId };
  if (booking.status !== "pending") return { type, bookingId: booking.id, ignored: `booking is ${booking.status}` };
  await cancelPendingBooking(db, { bookingId: booking.id, reason: "expired" });
  return { type, bookingId: booking.id, action: "cancelled" };
}

// ---------- refunds ----------

async function findPaymentForCharge(db: DbOrTx, venueId: string, chargeId: string | null, intentId: string | null): Promise<s.Payment | null> {
  const conds: SQL[] = [];
  if (chargeId) conds.push(eq(s.payments.providerChargeId, chargeId));
  if (intentId) conds.push(eq(s.payments.providerPaymentIntentId, intentId));
  if (conds.length === 0) return null;
  const [p] = await db
    .select()
    .from(s.payments)
    .where(and(eq(s.payments.venueId, venueId), eq(s.payments.provider, "stripe"), or(...conds)))
    .orderBy(asc(s.payments.createdAt))
    .limit(1);
  return p ?? null;
}

function refundStatus(v: unknown): s.Refund["status"] {
  if (v === "succeeded") return "succeeded";
  if (v === "failed" || v === "canceled") return "failed";
  return "pending";
}

async function chargeRefunded(db: DbOrTx, venue: Pick<s.Venue, "id">, type: string, charge: Obj): Promise<WebhookResult> {
  const chargeId = str(charge.id);
  const payment = await findPaymentForCharge(db, venue.id, chargeId, idOf(charge.payment_intent));
  if (!payment) return { type, ignored: "unknown payment" };
  if (chargeId && !payment.providerChargeId) {
    await db.update(s.payments).set({ providerChargeId: chargeId, updatedAt: new Date() }).where(eq(s.payments.id, payment.id));
  }

  const ours = await db.select().from(s.refunds).where(eq(s.refunds.paymentId, payment.id));
  const list = obj(charge.refunds).data;
  let added = 0;
  let settled = 0;

  if (Array.isArray(list)) {
    for (const item of list) {
      const r = obj(item);
      const refundId = str(r.id);
      const amount = num(r.amount);
      if (!refundId || amount === null) continue;
      const status = refundStatus(r.status);
      const known = ours.find((x) => x.providerRefundId === refundId);
      if (known) {
        if (known.status !== status && status !== "pending") {
          await db.update(s.refunds).set({ status, updatedAt: new Date() }).where(eq(s.refunds.id, known.id));
          settled++;
        }
        continue;
      }
      await recordProviderRefund(db, { paymentId: payment.id, amountPence: amount, providerRefundId: refundId, status });
      added++;
    }
  } else {
    // The charge's refunds list is not included: reconcile on the total instead.
    const total = num(charge.amount_refunded) ?? 0;
    const recorded = ours.filter((x) => x.status !== "failed").reduce((n, x) => n + x.amountPence, 0);
    for (const x of ours) {
      if (x.status === "pending" && total >= recorded) {
        await db.update(s.refunds).set({ status: "succeeded", updatedAt: new Date() }).where(eq(s.refunds.id, x.id));
        settled++;
      }
    }
    if (total > recorded) {
      await recordProviderRefund(db, {
        paymentId: payment.id,
        amountPence: total - recorded,
        providerRefundId: `${chargeId ?? payment.id}:${total}`,
        status: "succeeded",
      });
      added++;
    }
  }
  return { type, bookingId: payment.bookingId, action: `refunds added ${added}, settled ${settled}` };
}

// ---------- disputes ----------

async function disputeCreated(db: DbOrTx, venue: Pick<s.Venue, "id">, type: string, dispute: Obj): Promise<WebhookResult> {
  const disputeId = str(dispute.id);
  const payment = await findPaymentForCharge(db, venue.id, idOf(dispute.charge), idOf(dispute.payment_intent));
  if (!payment) return { type, ignored: "unknown payment" };
  await db
    .update(s.payments)
    .set({ status: "disputed", disputeId, updatedAt: new Date() })
    .where(eq(s.payments.id, payment.id));
  const [booking] = await db.select().from(s.bookings).where(eq(s.bookings.id, payment.bookingId)).limit(1);
  await audit(db, {
    user: null,
    action: "payment.dispute",
    entityType: "payment",
    entityId: payment.id,
    venueId: payment.venueId,
    before: { status: payment.status },
    after: { status: "disputed", disputeId, reason: str(dispute.reason), amountPence: num(dispute.amount) },
  });

  try {
    const org = await getOrganisation(db);
    const reference = booking?.reference ?? "unknown";
    const amount = fmtPence(num(dispute.amount) ?? payment.amountPence);
    const reason = (str(dispute.reason) ?? "not given").replace(/_/g, " ");
    const subject = `A card payment is being disputed: ${reference}`;
    const lines = [
      `The customer's bank has opened a dispute on the payment for booking ${reference} (${amount}). Reason: ${reason}.`,
      "Stripe charges a £20 dispute fee, returned if the dispute is won. Reply to it from the Stripe dashboard with the booking details, the terms the customer accepted and any messages.",
    ];
    const link = booking ? adminBookingUrl(booking.id) : null;
    const text = [...lines, link ? `Booking: ${link}` : ""].filter(Boolean).join("\n\n");
    const html = wrapHtml(
      lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") + (link ? `<p><a href="${escapeHtml(link)}">Open the booking</a></p>` : ""),
      brandFor(org),
      { title: subject },
    );
    await sendRawEmail(db, {
      to: env.ownerAlertEmail() ?? org.contactEmail,
      subject,
      html,
      text,
      template: "owner_dispute",
      venueId: payment.venueId,
    });
  } catch (e) {
    console.error("[webhooks] dispute alert failed:", e instanceof Error ? e.message : e);
  }
  return { type, bookingId: payment.bookingId, action: "disputed" };
}

/** Payments needing attention (disputed), for the admin. */
export async function listDisputedPayments(db: DbOrTx, venueIds: string[] | null): Promise<s.Payment[]> {
  const conds: SQL[] = [eq(s.payments.status, "disputed")];
  if (Array.isArray(venueIds)) {
    if (venueIds.length === 0) return [];
    conds.push(inArray(s.payments.venueId, venueIds));
  }
  return db.select().from(s.payments).where(and(...conds)).orderBy(asc(s.payments.createdAt));
}

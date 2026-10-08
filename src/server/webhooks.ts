/**
 * Stripe webhook handling (one endpoint per venue; the route verifies the signature).
 *
 * Idempotent: each (venue, event id) is recorded in `processed_webhook_events`
 * first and a repeat is ignored. If handling fails, or the event names a booking
 * or payment this venue does not know (yet), the record is removed so Stripe's
 * retry (or the right venue's endpoint) can process it. Bookings are confirmed
 * only here (and by the demo checkout), never from the customer's return URL, and
 * only when the amount paid covers the booking in the organisation's currency.
 *
 * The event objects are read structurally (only the fields used below), so the
 * handler does not depend on the Stripe SDK's type layout or API version. The
 * endpoint must send snapshot events (the full object in `data.object`), not
 * thin events.
 *
 * Refunds are reconciled strictly by Stripe's refund id (DECISIONS 34): event
 * payloads never include a charge's expanded refunds list, so the route passes
 * `listRefunds` (Stripe's `refunds.list` for the charge) and `charge.refunded`
 * only triggers a re-list. Nothing here invents a refund id, and a refund only
 * counts as gone through when Stripe says `succeeded`.
 */
import { and, asc, eq, inArray, isNull, notInArray, or, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { fmtPence } from "@/core/time";
import { env } from "@/lib/env";
import { escapeHtml, wrapHtml } from "@/providers/email/render";
import { audit } from "./audit";
import { cancelPendingBooking, confirmBookingPaid, findBookingIdByCheckout, recordProviderRefund, settleRefund } from "./bookings";
import { adminBookingUrl, brandFor, sendRawEmail } from "./notifications";
import { getOrganisation } from "./org";

/** The parts of a Stripe event BayPook reads. `Stripe.Event` is assignable to this. */
export type WebhookEvent = { id: string; type: string; data: { object: unknown } };

/** The parts of a Stripe refund BayPook reads. `Stripe.Refund` is assignable to this. */
export type ProviderRefund = { id: string; amount: number; status: string | null; created?: number; charge?: unknown; payment_intent?: unknown };

/**
 * Every refund Stripe holds for a charge, read from the venue's Stripe account
 * (`refunds.list({ charge })`). Absent in demo mode and in tests that do not
 * need it: `refund.*` events then use the refund in the event itself.
 */
export type ListRefunds = (chargeId: string) => Promise<readonly ProviderRefund[]>;

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
  input: { venue: Pick<s.Venue, "id" | "slug">; event: WebhookEvent; listRefunds?: ListRefunds },
): Promise<WebhookResult> {
  const { venue, event, listRefunds } = input;
  const inserted = await db
    .insert(s.processedWebhookEvents)
    .values({ id: event.id, venueId: venue.id, type: event.type })
    .onConflictDoNothing()
    .returning({ id: s.processedWebhookEvents.id });
  if (inserted.length === 0) return { type: event.type, duplicate: true };

  const forget = () =>
    db
      .delete(s.processedWebhookEvents)
      .where(and(eq(s.processedWebhookEvents.venueId, venue.id), eq(s.processedWebhookEvents.id, event.id)));
  let result: WebhookResult;
  try {
    result = await dispatch(db, venue, event, listRefunds);
  } catch (e) {
    // Let Stripe retry: forget that we saw this event.
    await forget();
    throw e;
  }
  // Nothing was recorded for an event we could not place: a retry may find it.
  if (result.ignored === "unknown booking" || result.ignored === "unknown payment") await forget();
  return result;
}

async function dispatch(
  db: DbOrTx,
  venue: Pick<s.Venue, "id" | "slug">,
  event: WebhookEvent,
  listRefunds: ListRefunds | undefined,
): Promise<WebhookResult> {
  const o = obj(event.data?.object);
  switch (event.type) {
    case "checkout.session.completed":
    // Checkout offers card payments only (DECISIONS 33), so the async events
    // should never arrive; they are still handled in case a session ever allows
    // a delayed method.
    case "checkout.session.async_payment_succeeded":
      return checkoutCompleted(db, venue, event.type, o);
    case "checkout.session.async_payment_failed":
      return checkoutAsyncFailed(db, venue, event.type, o);
    case "payment_intent.succeeded":
      return paymentIntentSucceeded(db, venue, event.type, o);
    case "checkout.session.expired":
      return checkoutExpired(db, venue, event.type, o);
    case "charge.refunded":
      return chargeRefunded(db, venue, event.type, o, listRefunds);
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
    // Deprecated: Stripe's older name for refund.updated. Still accepted for
    // endpoints that subscribed to it before; new endpoints use refund.*.
    case "charge.refund.updated":
      return refundChanged(db, venue, event.type, o, listRefunds);
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

/** True when this checkout or payment intent is already recorded as paid on the booking. */
async function alreadyRecorded(db: DbOrTx, bookingId: string, checkoutId: string | null, intentId: string | null): Promise<boolean> {
  const ids: SQL[] = [];
  if (checkoutId) ids.push(eq(s.payments.providerCheckoutId, checkoutId));
  if (intentId) ids.push(eq(s.payments.providerPaymentIntentId, intentId));
  if (ids.length === 0) return false;
  const [p] = await db
    .select({ id: s.payments.id })
    .from(s.payments)
    .where(and(eq(s.payments.bookingId, bookingId), notInArray(s.payments.status, ["pending", "failed"]), or(...ids)))
    .limit(1);
  return Boolean(p);
}

/**
 * Refuse a payment that does not cover the booking: missing amount, less than the
 * booking total, or another currency. Nothing is recorded; the owner is told.
 * Returns the reason, or null when the payment is fine.
 */
async function paymentMismatch(
  db: DbOrTx,
  booking: s.Booking,
  amount: number | null,
  currency: string | null,
  ids: { checkoutId: string | null; intentId: string | null },
): Promise<string | null> {
  if (await alreadyRecorded(db, booking.id, ids.checkoutId, ids.intentId)) return null;
  const org = await getOrganisation(db);
  const expected = (org.currency || "gbp").toLowerCase();
  let problem: string | null = null;
  if (amount === null || !Number.isInteger(amount)) problem = "the event did not say how much was paid";
  else if ((currency ?? "").toLowerCase() !== expected) problem = `it was paid in ${(currency ?? "an unknown currency").toUpperCase()}, not ${expected.toUpperCase()}`;
  else if (amount < booking.totalPence) problem = `${fmtPence(amount)} was paid but the booking costs ${fmtPence(booking.totalPence)}`;
  if (!problem) return null;
  try {
    const subject = `A payment for booking ${booking.reference} did not match`;
    const lines = [
      `Stripe reported a payment for booking ${booking.reference}, but ${problem}, so the booking was not confirmed and nothing was recorded.`,
      "Please check the payment in the Stripe dashboard and refund it or contact the customer.",
    ];
    const link = adminBookingUrl(booking.id);
    await sendRawEmail(db, {
      to: env.ownerAlertEmail() ?? org.contactEmail,
      subject,
      html: wrapHtml(lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") + `<p><a href="${escapeHtml(link)}">Open the booking</a></p>`, brandFor(org), {
        title: subject,
      }),
      text: [...lines, `Booking: ${link}`].join("\n\n"),
      template: "owner_payment_mismatch",
      venueId: booking.venueId,
    });
  } catch (e) {
    console.error("[webhooks] payment mismatch alert failed:", e instanceof Error ? e.message : e);
  }
  return problem;
}

async function checkoutCompleted(db: DbOrTx, venue: Pick<s.Venue, "id">, type: string, session: Obj): Promise<WebhookResult> {
  if (session.payment_status !== "paid") return { type, ignored: "unpaid" };
  const checkoutId = str(session.id);
  let bookingId = metadataBookingId(session);
  if (!bookingId && checkoutId) bookingId = await findBookingIdByCheckout(db, checkoutId);
  const booking = await bookingInVenue(db, bookingId, venue.id);
  if (!booking) return { type, ignored: "unknown booking", bookingId };
  const intentId = idOf(session.payment_intent);
  const amount = num(session.amount_total);
  const currency = str(session.currency);
  if (await paymentMismatch(db, booking, amount, currency, { checkoutId, intentId })) {
    return { type, bookingId: booking.id, ignored: "amount mismatch" };
  }
  const res = await confirmBookingPaid(db, {
    bookingId: booking.id,
    payment: {
      provider: "stripe",
      providerCheckoutId: checkoutId,
      providerPaymentIntentId: intentId,
      amountPence: amount ?? 0,
      currency: currency ?? "gbp",
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
  const amount = num(pi.amount_received) ?? num(pi.amount);
  const currency = str(pi.currency);
  if (await paymentMismatch(db, booking, amount, currency, { checkoutId: null, intentId })) {
    return { type, bookingId: booking.id, ignored: "amount mismatch" };
  }
  const res = await confirmBookingPaid(db, {
    bookingId: booking.id,
    payment: {
      provider: "stripe",
      providerPaymentIntentId: intentId,
      providerChargeId: idOf(pi.latest_charge),
      amountPence: amount ?? 0,
      currency: currency ?? "gbp",
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

/** A delayed payment (bank debit and the like) failed: free the places if the booking is still pending. */
async function checkoutAsyncFailed(db: DbOrTx, venue: Pick<s.Venue, "id">, type: string, session: Obj): Promise<WebhookResult> {
  const checkoutId = str(session.id);
  let bookingId = metadataBookingId(session);
  if (!bookingId && checkoutId) bookingId = await findBookingIdByCheckout(db, checkoutId);
  const booking = await bookingInVenue(db, bookingId, venue.id);
  if (!booking) return { type, ignored: "unknown booking", bookingId };
  if (booking.status !== "pending") return { type, bookingId: booking.id, ignored: `booking is ${booking.status}` };
  await cancelPendingBooking(db, { bookingId: booking.id, reason: "declined" });
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

/** Remember the charge id on a payment confirmed from Checkout (which only carries the payment intent). */
async function rememberCharge(db: DbOrTx, payment: s.Payment, chargeId: string | null): Promise<void> {
  if (!chargeId || payment.providerChargeId) return;
  await db.update(s.payments).set({ providerChargeId: chargeId, updatedAt: new Date() }).where(eq(s.payments.id, payment.id));
}

/** Stripe refund status to ours: `pending` and `requires_action` are still pending; `canceled` counts as failed. */
function refundStatus(v: unknown): s.Refund["status"] {
  if (v === "succeeded") return "succeeded";
  if (v === "failed" || v === "canceled") return "failed";
  return "pending";
}

type SeenRefund = { id: string; amount: number; status: s.Refund["status"]; created: number };

function readRefund(v: unknown): SeenRefund | null {
  const r = obj(v);
  const id = str(r.id);
  const amount = num(r.amount);
  if (!id || amount === null || !Number.isInteger(amount) || amount <= 0) return null;
  return { id, amount, status: refundStatus(r.status), created: num(r.created) ?? 0 };
}

/** The refund row (in this venue) that already carries this Stripe refund id. */
async function refundRowById(db: DbOrTx, venueId: string, providerRefundId: string): Promise<s.Refund | null> {
  const [row] = await db
    .select({ refund: s.refunds })
    .from(s.refunds)
    .innerJoin(s.payments, eq(s.payments.id, s.refunds.paymentId))
    .where(and(eq(s.refunds.providerRefundId, providerRefundId), eq(s.payments.venueId, venueId)))
    .limit(1);
  return row?.refund ?? null;
}

type Reconciled = { outcome: "added" | "settled" | "unchanged"; status: s.Refund["status"]; bookingId: string };

/**
 * Reconcile one Stripe refund with BayPook's rows, strictly by Stripe's refund id:
 *  1. the row that already carries this id;
 *  2. else one of our own refunds still waiting for its id (`refundBooking`
 *     reserves a `pending` row before it calls Stripe) on the same payment with
 *     the same amount: it takes the id and Stripe's status;
 *  3. else a refund made outside BayPook (the Stripe dashboard), recorded with
 *     Stripe's status.
 * Stripe's `pending` never moves a row backwards, and only `succeeded` makes a
 * refund count as gone through (`settleRefund` and `recordProviderRefund` email
 * the customer at that moment, once). A refund that fails stops counting.
 * Returns null when neither a row nor the payment is known.
 */
async function reconcileRefund(
  db: DbOrTx,
  input: { venueId: string; payment: s.Payment | null; refund: SeenRefund; claimed: Set<string> },
): Promise<Reconciled | null> {
  const { payment, refund, claimed } = input;
  let known = await refundRowById(db, input.venueId, refund.id);
  if (!known && payment) {
    const waiting = await db
      .select()
      .from(s.refunds)
      .where(
        and(
          eq(s.refunds.paymentId, payment.id),
          eq(s.refunds.status, "pending"),
          isNull(s.refunds.providerRefundId),
          eq(s.refunds.amountPence, refund.amount),
        ),
      )
      .orderBy(asc(s.refunds.createdAt));
    known = waiting.find((x) => !claimed.has(x.id)) ?? null;
  }
  if (known) {
    claimed.add(known.id);
    const next = refund.status === "pending" ? known.status : refund.status;
    if (next === known.status && known.providerRefundId === refund.id) {
      return { outcome: "unchanged", status: known.status, bookingId: known.bookingId };
    }
    const settled = await settleRefund(db, { refundId: known.id, status: next, providerRefundId: refund.id });
    return { outcome: "settled", status: settled?.refund.status ?? next, bookingId: known.bookingId };
  }
  if (!payment) return null;
  const added = await recordProviderRefund(db, {
    paymentId: payment.id,
    amountPence: refund.amount,
    providerRefundId: refund.id,
    status: refund.status,
  });
  return { outcome: added ? "added" : "unchanged", status: refund.status, bookingId: payment.bookingId };
}

/**
 * `charge.refunded` says the charge's refunds changed but (in snapshot events)
 * never lists them, so it is only a trigger: re-list the charge's refunds from
 * Stripe and reconcile each one. Without `listRefunds` (demo mode) an embedded
 * `refunds.data` list from an older API version is used when present; otherwise
 * the event is ignored and the `refund.*` events carry the change.
 */
async function chargeRefunded(
  db: DbOrTx,
  venue: Pick<s.Venue, "id">,
  type: string,
  charge: Obj,
  listRefunds: ListRefunds | undefined,
): Promise<WebhookResult> {
  const chargeId = str(charge.id);
  const embedded = obj(charge.refunds).data;
  if (!(listRefunds && chargeId) && !Array.isArray(embedded)) return { type, ignored: "no refund list" };
  const payment = await findPaymentForCharge(db, venue.id, chargeId, idOf(charge.payment_intent));
  if (!payment) return { type, ignored: "unknown payment" };
  await rememberCharge(db, payment, chargeId);

  const listed: readonly unknown[] = listRefunds && chargeId ? await listRefunds(chargeId) : Array.isArray(embedded) ? embedded : [];
  // Oldest first, so our oldest waiting refund takes the oldest Stripe refund of the same amount.
  const refunds = listed
    .map(readRefund)
    .filter((r): r is SeenRefund => r !== null)
    .sort((a, b) => a.created - b.created);
  const claimed = new Set<string>();
  let added = 0;
  let settled = 0;
  for (const refund of refunds) {
    const res = await reconcileRefund(db, { venueId: venue.id, payment, refund, claimed });
    if (res?.outcome === "added") added++;
    if (res?.outcome === "settled") settled++;
  }
  return { type, bookingId: payment.bookingId, action: `refunds added ${added}, settled ${settled}` };
}

/**
 * `refund.created`, `refund.updated`, `refund.failed` (and the deprecated
 * `charge.refund.updated`): one refund was created or changed state. Events can
 * arrive out of order, so with `listRefunds` the refund's current state is read
 * back from Stripe; otherwise the event's own refund object is used. Then it is
 * reconciled like any refund of `charge.refunded`.
 */
async function refundChanged(
  db: DbOrTx,
  venue: Pick<s.Venue, "id">,
  type: string,
  object: Obj,
  listRefunds: ListRefunds | undefined,
): Promise<WebhookResult> {
  let refund = readRefund(object);
  if (!refund) return { type, ignored: "no refund id" };
  const chargeId = idOf(object.charge);
  const payment = await findPaymentForCharge(db, venue.id, chargeId, idOf(object.payment_intent));
  if (!payment && !(await refundRowById(db, venue.id, refund.id))) return { type, ignored: "unknown payment" };
  if (payment) await rememberCharge(db, payment, chargeId);

  if (listRefunds && chargeId) {
    const id = refund.id;
    const current = (await listRefunds(chargeId)).map(readRefund).find((r) => r?.id === id);
    if (current) refund = current;
  }

  const res = await reconcileRefund(db, { venueId: venue.id, payment, refund, claimed: new Set() });
  if (!res) return { type, ignored: "unknown payment" };
  if (res.outcome === "settled") return { type, bookingId: res.bookingId, action: `refund ${res.status}` };
  if (res.outcome === "added") return { type, bookingId: res.bookingId, action: "refund added" };
  return { type, bookingId: res.bookingId, ignored: `refund is ${res.status}` };
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
      "Stripe charges dispute fees (see Stripe pricing). Reply to it from the Stripe dashboard with the booking details, the terms the customer accepted and any messages.",
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

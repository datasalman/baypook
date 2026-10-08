/**
 * The booking service. Every change to a booking goes through here, is checked
 * against the state machine (`@/core/booking-state`) and is written to the audit
 * log with before/after snapshots of the fields that changed.
 *
 * Side effects that talk to the outside world (emails, the calendar mirror) run
 * after the database transaction commits and never throw: a failed email must
 * not undo a confirmed payment.
 */
import { and, asc, desc, eq, gte, ilike, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { assertTransition, BookingStateError, type BookingStatus } from "@/core/booking-state";
import { PricingError, type Quote } from "@/core/pricing";
import { generateReference, generateToken } from "@/core/reference";
import { addMinutes, DEFAULT_TZ, fmtDayLong, fmtPence, fmtTime, localDate } from "@/core/time";
import type { NotBookableReason } from "@/core/availability";
import { getPaymentProvider } from "@/providers";
import { AvailabilityError, assertBookable } from "./availability";
import { getService, isUuid, type ServiceWithCatalogue } from "./catalogue";
import { quoteForService } from "./quote";
import { attachHoldToBooking, markHoldConverted } from "./holds";
import { ensureVenueSessions } from "./sessions";
import { findOrCreateCustomer } from "./customers";
import { getOrganisation } from "./org";
import { audit } from "./audit";
import { canAccessVenue, canRefund, type CurrentUser } from "./auth";
import { adminBookingUrl, brandFor, sendBookingEmail, sendRawEmail } from "./notifications";
import { syncBookingToCalendar } from "./calendar";
import { escapeHtml, wrapHtml } from "@/providers/email/render";
import { env } from "@/lib/env";

// ---------- errors ----------

export type BookingErrorCode = "GONE" | "LIMIT" | "INVALID" | "NOT_FOUND" | "FORBIDDEN" | "STATE" | "UNAVAILABLE";

export class BookingError extends Error {
  code: BookingErrorCode;
  limit?: number;
  reason?: NotBookableReason;
  constructor(code: BookingErrorCode, message: string, extra: { limit?: number; reason?: NotBookableReason } = {}) {
    super(message);
    this.name = "BookingError";
    this.code = code;
    if (extra.limit !== undefined) this.limit = extra.limit;
    if (extra.reason) this.reason = extra.reason;
  }
}

/** Map errors from the rules modules into BookingError (others pass through). */
export function toBookingError(e: unknown): unknown {
  if (e instanceof BookingError) return e;
  if (e instanceof AvailabilityError) return new BookingError(e.code, e.message, { limit: e.limit, reason: e.reason });
  if (e instanceof PricingError) return new BookingError(e.code, e.message, { limit: e.limit });
  if (e instanceof BookingStateError) return new BookingError("STATE", e.message);
  return e;
}

async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toBookingError(e);
  }
}

// ---------- small helpers ----------

type PaymentInsert = typeof s.payments.$inferInsert;
type BookingUpdate = Partial<typeof s.bookings.$inferInsert>;

function logSideEffectError(what: string, e: unknown): void {
  console.error(`[bookings] ${what} failed:`, e instanceof Error ? e.message : e);
}

/** Run an outside-world side effect; log and swallow any error. */
async function sideEffect(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    logSideEffectError(what, e);
  }
}

/** Customer-facing emails are skipped (not failed) when the customer has no email address, e.g. a walk-in. */
async function emailCustomer(
  db: DbOrTx,
  what: string,
  args: Parameters<typeof sendBookingEmail>[1],
): Promise<void> {
  await sideEffect(what, async () => {
    const [row] = await db
      .select({ email: s.customers.email })
      .from(s.bookings)
      .innerJoin(s.customers, eq(s.customers.id, s.bookings.customerId))
      .where(eq(s.bookings.id, args.bookingId))
      .limit(1);
    if (!row || !row.email.trim()) return;
    await sendBookingEmail(db, args);
  });
}

function requireAccess(user: CurrentUser, venueId: string): void {
  if (!canAccessVenue(user, venueId)) throw new BookingError("FORBIDDEN", "You do not have access to this venue.");
}

/** Only the given keys, for audit before/after snapshots. */
function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = obj[k];
  return out;
}

const STATUS_FIELDS = ["status", "paymentStatus", "paidPence", "refundedPence"] as const;

function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur === "object" && cur !== null && (cur as { code?: unknown }).code === "23505") return true;
    cur = typeof cur === "object" && cur !== null ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * The payment summary kept on the booking (see DECISIONS.md 11), derived from
 * its money columns. What is still owed (`total - (paid - refunded)`) comes
 * first: a booking whose places went up after a partial refund owes money, it is
 * not "partially refunded". A cancelled booking owes nothing, so for it (and when
 * nothing is owed) the refund state wins.
 */
export function derivePaymentStatus(
  b: Pick<s.Booking, "totalPence" | "paidPence" | "refundedPence" | "paymentMethod"> & { status?: s.Booking["status"] },
): s.Booking["paymentStatus"] {
  const unpaid = b.paymentMethod === "online_card" ? "unpaid" : "owed";
  const net = b.paidPence - b.refundedPence;
  if (b.status !== "cancelled" && b.totalPence - net > 0) {
    return b.paidPence <= 0 && b.refundedPence <= 0 ? unpaid : "owed";
  }
  if (b.refundedPence > 0) return b.refundedPence >= b.paidPence ? "refunded" : "partially_refunded";
  if (b.paidPence <= 0) return b.totalPence <= 0 ? "paid" : unpaid;
  return b.paidPence >= b.totalPence ? "paid" : "owed";
}

async function loadBookingRow(db: DbOrTx, bookingId: string, lock = false): Promise<s.Booking> {
  if (!isUuid(bookingId)) throw new BookingError("NOT_FOUND", "We could not find that booking.");
  const q = db.select().from(s.bookings).where(eq(s.bookings.id, bookingId)).limit(1);
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw new BookingError("NOT_FOUND", "We could not find that booking.");
  return row;
}

async function loadVenue(db: DbOrTx, venueId: string): Promise<s.Venue> {
  const [venue] = await db.select().from(s.venues).where(eq(s.venues.id, venueId)).limit(1);
  if (!venue) throw new BookingError("NOT_FOUND", "We could not find that venue.");
  return venue;
}

async function loadService(db: DbOrTx, serviceId: string): Promise<ServiceWithCatalogue> {
  const service = await getService(db, serviceId, { includeArchived: true });
  if (!service) throw new BookingError("NOT_FOUND", "We could not find that service.");
  return service;
}

async function updateBooking(tx: DbOrTx, id: string, changes: BookingUpdate): Promise<s.Booking> {
  const [row] = await tx
    .update(s.bookings)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(s.bookings.id, id))
    .returning();
  return row;
}

/**
 * Insert a booking with a fresh reference and token, retrying on the (rare) unique
 * collision. Each attempt runs in a savepoint so a collision does not abort the
 * surrounding transaction.
 */
async function insertBooking(
  tx: DbOrTx,
  values: Omit<typeof s.bookings.$inferInsert, "reference" | "token">,
): Promise<s.Booking> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await tx.transaction(async (sp) => {
        const [row] = await sp
          .insert(s.bookings)
          .values({ ...values, reference: generateReference(), token: generateToken() })
          .returning();
        return row;
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not create a unique booking reference");
}

/** Make sure session rows exist on the local days a slot interval touches (they are conflicts for slots). */
async function ensureSessionsAround(db: DbOrTx, venueId: string, startsAt: Date, endsAt: Date, tz: string): Promise<void> {
  const from = localDate(startsAt, tz);
  const to = localDate(new Date(endsAt.getTime() - 1), tz);
  await ensureVenueSessions(db, venueId, from, to < from ? from : to, tz);
}

/**
 * The payment provider checkouts still open for a pending booking: its pending
 * payment rows and its hold (when the hold is this booking's). Read them before
 * the pending payments are marked failed.
 */
async function openCheckoutIds(tx: DbOrTx, booking: Pick<s.Booking, "id" | "holdId">): Promise<string[]> {
  const ids = new Set<string>();
  const pending = await tx
    .select({ checkoutId: s.payments.providerCheckoutId })
    .from(s.payments)
    .where(and(eq(s.payments.bookingId, booking.id), eq(s.payments.status, "pending")));
  for (const p of pending) if (p.checkoutId) ids.add(p.checkoutId);
  if (booking.holdId) {
    const [hold] = await tx
      .select({ checkoutId: s.holds.checkoutId, bookingId: s.holds.bookingId })
      .from(s.holds)
      .where(eq(s.holds.id, booking.holdId))
      .limit(1);
    if (hold?.checkoutId && hold.bookingId === booking.id) ids.add(hold.checkoutId);
  }
  return Array.from(ids);
}

/** Close payment pages that can no longer confirm anything. Best effort, after commit; never throws. */
async function expireCheckouts(db: DbOrTx, venueId: string, checkoutIds: string[]): Promise<void> {
  if (checkoutIds.length === 0) return;
  await sideEffect("expire checkout", async () => {
    const venue = await loadVenue(db, venueId);
    const resolved = await getPaymentProvider(venue.slug);
    if (!resolved) return;
    for (const id of checkoutIds) await sideEffect(`expire checkout ${id}`, () => resolved.provider.expireCheckout(id));
  });
}

// ---------- creating bookings ----------

export type BookingCustomerInput = { firstName: string; lastName: string; email: string; phone?: string | null };

/**
 * Create the booking for a hold being paid for (checkout). Online card: status
 * pending, payment unpaid; the hold is attached to the booking and stays the
 * expiry timer. Pay in store: confirmed straight away with payment owed; the hold
 * is converted. Places, lines and totals come from the server quote.
 */
export async function createPendingBookingFromHold(
  tx: DbOrTx,
  input: {
    hold: s.Hold;
    quote: Quote;
    venue: s.Venue;
    service: s.Service;
    organisation: s.Organisation;
    customer: BookingCustomerInput;
    birthdayChild?: { firstName: string; age: number } | null;
    message?: string | null;
    acceptedAt: Date;
    termsVersion: number;
    waiverVersion: number;
    paymentMethod: "online_card" | "pay_in_store";
    createdBy?: string | null;
  },
): Promise<s.Booking> {
  const { hold, quote: q, venue, service, organisation } = input;
  const customer = await findOrCreateCustomer(tx, { organisationId: organisation.id, ...input.customer });
  const confirmed = input.paymentMethod === "pay_in_store";
  const isSlot = service.kind === "slot";
  const message = input.message?.trim() || null;

  // The session's own room (holds made before sessions kept their room stored the service's).
  let roomId = hold.roomId;
  if (hold.sessionId) {
    const [session] = await tx.select({ roomId: s.sessions.roomId }).from(s.sessions).where(eq(s.sessions.id, hold.sessionId)).limit(1);
    if (session) roomId = session.roomId;
  }

  const booking = await insertBooking(tx, {
    venueId: venue.id,
    serviceId: service.id,
    roomId,
    sessionId: hold.sessionId,
    customerId: customer.id,
    startsAt: hold.startsAt,
    endsAt: hold.endsAt,
    status: confirmed ? "confirmed" : "pending",
    lines: q.lines,
    addOns: q.addOns,
    places: q.places,
    subtotalPence: q.subtotalPence,
    totalPence: q.totalPence,
    paidPence: 0,
    refundedPence: 0,
    birthdayChildFirstName: isSlot ? input.birthdayChild?.firstName.trim() || null : null,
    birthdayChildAge: isSlot ? (input.birthdayChild?.age ?? null) : null,
    source: "online",
    paymentMethod: input.paymentMethod,
    paymentStatus: derivePaymentStatus({ totalPence: q.totalPence, paidPence: 0, refundedPence: 0, paymentMethod: input.paymentMethod }),
    termsVersion: input.termsVersion,
    waiverVersion: input.waiverVersion,
    acceptedAt: input.acceptedAt,
    customerMessage: message,
    holdId: hold.id,
    createdBy: input.createdBy ?? null,
  });

  if (confirmed) await markHoldConverted(tx, hold.id, booking.id);
  else await attachHoldToBooking(tx, hold.id, { bookingId: booking.id });

  await audit(tx, {
    user: null,
    action: confirmed ? "booking.create_pay_in_store" : "booking.create_pending",
    entityType: "booking",
    entityId: booking.id,
    venueId: venue.id,
    before: null,
    after: pick(booking, ["reference", "status", "paymentStatus", "paymentMethod", "totalPence", "places", "startsAt", "endsAt"]),
  });
  return booking;
}

// ---------- confirming payment ----------

export type ConfirmPaymentInput = {
  provider: "stripe" | "demo";
  providerCheckoutId?: string | null;
  providerPaymentIntentId?: string | null;
  providerChargeId?: string | null;
  amountPence: number;
  currency: string;
};

/**
 * The single confirmation path, used by the Stripe webhook and the demo checkout.
 * Idempotent: a payment already recorded as succeeded with the same checkout id or
 * payment intent returns `alreadyConfirmed`. A payment that arrives after the
 * booking was cancelled (hold lapsed) reinstates it when the time is still free;
 * otherwise the payment is recorded, the booking stays cancelled and the owner is
 * alerted to refund it.
 */
export async function confirmBookingPaid(
  db: DbOrTx,
  input: { bookingId: string; payment: ConfirmPaymentInput; now?: Date },
): Promise<{ booking: s.Booking; alreadyConfirmed: boolean }> {
  const { payment } = input;
  const now = input.now ?? new Date();
  if (!Number.isInteger(payment.amountPence) || payment.amountPence < 0) {
    throw new BookingError("INVALID", "The payment amount is not valid.");
  }

  type Outcome = {
    booking: s.Booking;
    alreadyConfirmed: boolean;
    newlyConfirmed: boolean;
    needsRefund: boolean;
    rivalCheckoutIds: string[];
  };

  const outcome: Outcome = await mapErrors(() =>
    db.transaction(async (tx): Promise<Outcome> => {
      const before = await loadBookingRow(tx, input.bookingId, true);

      // ----- idempotency -----
      const matchIds: SQL[] = [];
      if (payment.providerCheckoutId) matchIds.push(eq(s.payments.providerCheckoutId, payment.providerCheckoutId));
      if (payment.providerPaymentIntentId) matchIds.push(eq(s.payments.providerPaymentIntentId, payment.providerPaymentIntentId));
      const existingPayments = await tx
        .select()
        .from(s.payments)
        .where(and(eq(s.payments.bookingId, before.id), eq(s.payments.provider, payment.provider)))
        .orderBy(asc(s.payments.createdAt));
      const recorded = existingPayments.filter((p) => p.status !== "pending" && p.status !== "failed");
      const sameIds = recorded.find(
        (p) =>
          (payment.providerCheckoutId && p.providerCheckoutId === payment.providerCheckoutId) ||
          (payment.providerPaymentIntentId && p.providerPaymentIntentId === payment.providerPaymentIntentId),
      );
      // A payment-intent-only event after a checkout event that carried no intent id.
      const sameWithoutIntent =
        !payment.providerCheckoutId && payment.providerPaymentIntentId
          ? recorded.find((p) => !p.providerPaymentIntentId && p.amountPence === payment.amountPence)
          : undefined;
      const match = sameIds ?? sameWithoutIntent;
      if (match) {
        const fill: Partial<PaymentInsert> = {};
        if (payment.providerPaymentIntentId && !match.providerPaymentIntentId) fill.providerPaymentIntentId = payment.providerPaymentIntentId;
        if (payment.providerChargeId && !match.providerChargeId) fill.providerChargeId = payment.providerChargeId;
        if (Object.keys(fill).length) {
          await tx.update(s.payments).set({ ...fill, updatedAt: new Date() }).where(eq(s.payments.id, match.id));
        }
        return { booking: before, alreadyConfirmed: true, newlyConfirmed: false, needsRefund: false, rivalCheckoutIds: [] };
      }

      // ----- can the booking (still) be confirmed? -----
      let target: BookingStatus = before.status;
      let needsRefund = false;
      let rivalCheckoutIds: string[] = [];
      if (before.status === "pending") {
        assertTransition("pending", "confirmed");
        target = "confirmed";
      } else if (before.status === "cancelled") {
        const venue = await loadVenue(tx, before.venueId);
        const service = await loadService(tx, before.serviceId);
        // The customer pressed Pay again (a second pending booking replaced this one on
        // the same hold) and then paid the first payment page. Reinstating this booking
        // replaces that pending one, which would otherwise keep the same places forever.
        const rival = await rivalPendingBooking(tx, before);
        try {
          // A savepoint: if the time is no longer free, the other booking stays as it was.
          rivalCheckoutIds = await tx.transaction(async (sp) => {
            let ids: string[] = [];
            if (rival) {
              const res = await cancelPendingBookingInTx(sp, {
                bookingId: rival.id,
                reason: "abandoned",
                action: "booking.cancel_pending.replaced_by_paid",
              });
              ids = res.checkoutIds;
            }
            await assertBookable(sp, {
              venue,
              service,
              sessionId: before.sessionId,
              startsAt: before.startsAt,
              endsAt: before.endsAt,
              places: before.places,
              now,
              excludeBookingId: before.id,
              ignoreTiming: true,
            });
            return ids;
          });
          assertTransition("cancelled", "confirmed");
          target = "confirmed";
        } catch (e) {
          if (!(e instanceof AvailabilityError)) throw e;
          rivalCheckoutIds = [];
          needsRefund = true;
        }
      }

      // ----- record the payment -----
      const pendingRow =
        existingPayments.find((p) => p.status === "pending" && payment.providerCheckoutId && p.providerCheckoutId === payment.providerCheckoutId) ??
        existingPayments.find((p) => p.status === "pending");
      if (pendingRow) {
        await tx
          .update(s.payments)
          .set({
            status: "succeeded",
            amountPence: payment.amountPence,
            currency: payment.currency,
            providerCheckoutId: payment.providerCheckoutId ?? pendingRow.providerCheckoutId,
            providerPaymentIntentId: payment.providerPaymentIntentId ?? pendingRow.providerPaymentIntentId,
            providerChargeId: payment.providerChargeId ?? pendingRow.providerChargeId,
            updatedAt: new Date(),
          })
          .where(eq(s.payments.id, pendingRow.id));
      } else {
        await tx.insert(s.payments).values({
          bookingId: before.id,
          venueId: before.venueId,
          provider: payment.provider,
          providerCheckoutId: payment.providerCheckoutId ?? null,
          providerPaymentIntentId: payment.providerPaymentIntentId ?? null,
          providerChargeId: payment.providerChargeId ?? null,
          amountPence: payment.amountPence,
          currency: payment.currency,
          status: "succeeded",
          method: "online_card",
        });
      }

      const paidPence = before.paidPence + payment.amountPence;
      const changes: BookingUpdate = {
        paidPence,
        paymentStatus: derivePaymentStatus({ ...before, paidPence, status: target }),
      };
      if (target !== before.status) {
        changes.status = target;
        changes.cancelledAt = null;
        changes.cancelReason = null;
      }
      const booking = await updateBooking(tx, before.id, changes);

      if (before.holdId && target === "confirmed") {
        // Only this booking's own hold is converted; a hold that has moved on to
        // another booking is left pointing at it.
        const [hold] = await tx.select().from(s.holds).where(eq(s.holds.id, before.holdId)).for("update");
        if (hold && (hold.bookingId === before.id || hold.bookingId === null)) await markHoldConverted(tx, hold.id, before.id);
      }

      await audit(tx, {
        user: null,
        action: needsRefund ? "booking.paid_after_cancel" : "booking.confirm_paid",
        entityType: "booking",
        entityId: booking.id,
        venueId: booking.venueId,
        before: pick(before, STATUS_FIELDS),
        after: { ...pick(booking, STATUS_FIELDS), provider: payment.provider, amountPence: payment.amountPence },
      });
      return {
        booking,
        alreadyConfirmed: false,
        newlyConfirmed: target === "confirmed" && before.status !== "confirmed",
        needsRefund,
        rivalCheckoutIds,
      };
    }),
  );

  await expireCheckouts(db, outcome.booking.venueId, outcome.rivalCheckoutIds);

  if (outcome.newlyConfirmed) {
    const b = outcome.booking;
    await emailCustomer(db, "confirmation email", { bookingId: b.id, template: "confirmation", dedupe: true });
    const [svc] = await db.select({ kind: s.services.kind }).from(s.services).where(eq(s.services.id, b.serviceId)).limit(1);
    if (svc?.kind === "slot") {
      await sideEffect("owner party alert", () => sendBookingEmail(db, { bookingId: b.id, template: "owner_new_party", dedupe: true }));
    }
    await sideEffect("calendar create", () => syncBookingToCalendar(db, b.id, "create"));
  }
  if (outcome.needsRefund) {
    await sideEffect("late payment alert", () => sendLatePaymentAlert(db, outcome.booking, payment.amountPence));
  }
  return { booking: outcome.booking, alreadyConfirmed: outcome.alreadyConfirmed };
}

/** Another pending booking that took over this booking's hold (the customer pressed Pay again). Locked. */
async function rivalPendingBooking(tx: DbOrTx, booking: s.Booking): Promise<s.Booking | null> {
  if (!booking.holdId) return null;
  const [hold] = await tx.select().from(s.holds).where(eq(s.holds.id, booking.holdId)).for("update");
  if (!hold?.bookingId || hold.bookingId === booking.id) return null;
  const [rival] = await tx.select().from(s.bookings).where(eq(s.bookings.id, hold.bookingId)).for("update");
  return rival && rival.status === "pending" ? rival : null;
}

async function ownerAlert(db: DbOrTx, venueId: string, subject: string, paragraphs: string[], link?: string): Promise<void> {
  const org = await getOrganisation(db);
  const to = env.ownerAlertEmail() ?? org.contactEmail;
  const text = [...paragraphs, link ? `Open it in BayPook: ${link}` : ""].filter(Boolean).join("\n\n");
  const inner =
    paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("") +
    (link ? `<p><a href="${escapeHtml(link)}">Open it in BayPook</a></p>` : "");
  await sendRawEmail(db, {
    to,
    subject,
    html: wrapHtml(inner, brandFor(org), { title: subject }),
    text,
    template: "owner_alert",
    venueId,
  });
}

async function sendLatePaymentAlert(db: DbOrTx, booking: s.Booking, amountPence: number): Promise<void> {
  await ownerAlert(
    db,
    booking.venueId,
    `A payment came in after booking ${booking.reference} was cancelled`,
    [
      `We received ${fmtPence(amountPence)} for booking ${booking.reference}, but its hold had already run out and the time is no longer free, so the booking was not confirmed.`,
      "Please give the customer a refund from the booking page, or call them to find another time.",
    ],
    adminBookingUrl(booking.id),
  );
}

// ---------- cancelling ----------

export type PendingCancelReason = "expired" | "declined" | "abandoned";

/**
 * pending -> cancelled inside the caller's transaction (locks the booking row).
 * Returns whether it changed anything and the checkouts that were still open, for
 * the caller to expire after commit. No-op unless pending.
 */
export async function cancelPendingBookingInTx(
  tx: DbOrTx,
  input: { bookingId: string; reason: PendingCancelReason; action?: string },
): Promise<{ cancelled: boolean; venueId: string | null; checkoutIds: string[] }> {
  const before = await loadBookingRow(tx, input.bookingId, true);
  if (before.status !== "pending") return { cancelled: false, venueId: before.venueId, checkoutIds: [] };
  assertTransition("pending", "cancelled");
  const checkoutIds = await openCheckoutIds(tx, before);
  const booking = await updateBooking(tx, before.id, {
    status: "cancelled",
    cancelledAt: new Date(),
    cancelReason: input.reason,
  });
  if (before.holdId) {
    await tx
      .update(s.holds)
      .set({ status: input.reason === "expired" ? "expired" : "released" })
      .where(and(eq(s.holds.id, before.holdId), eq(s.holds.status, "active")));
  }
  await tx
    .update(s.payments)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and(eq(s.payments.bookingId, before.id), eq(s.payments.status, "pending")));
  await audit(tx, {
    user: null,
    action: input.action ?? `booking.cancel_pending.${input.reason}`,
    entityType: "booking",
    entityId: booking.id,
    venueId: booking.venueId,
    before: pick(before, ["status"]),
    after: pick(booking, ["status", "cancelReason"]),
  });
  return { cancelled: true, venueId: before.venueId, checkoutIds };
}

/**
 * pending -> cancelled (hold expired, payment declined or abandoned). No email.
 * No-op unless pending. Unless the reason is "expired" (the provider or the
 * expiry job closes those), the booking's open checkout is expired with the
 * payment provider after commit, so it cannot be paid any more.
 */
export async function cancelPendingBooking(
  db: DbOrTx,
  input: { bookingId: string; reason: PendingCancelReason },
): Promise<void> {
  const res = await mapErrors(() => db.transaction((tx) => cancelPendingBookingInTx(tx, input)));
  if (res.cancelled && res.venueId && input.reason !== "expired") await expireCheckouts(db, res.venueId, res.checkoutIds);
}

/**
 * confirmed -> cancelled by an admin, with an optional refund first (refund
 * permission is checked before anything changes). Sends the cancellation email
 * and removes the calendar event.
 */
export async function cancelBooking(
  db: DbOrTx,
  input: { bookingId: string; user: CurrentUser; reason: string; refund?: { amountPence: number } | null; now?: Date },
): Promise<s.Booking> {
  const { user } = input;
  const current = await loadBookingRow(db, input.bookingId);
  requireAccess(user, current.venueId);
  await mapErrors(async () => assertTransition(current.status, "cancelled"));
  const refundAmount = input.refund?.amountPence ?? 0;
  if (refundAmount > 0) {
    if (!canRefund(user, current.venueId)) throw new BookingError("FORBIDDEN", "Only a manager or the owner can give a refund.");
    await refundBooking(db, {
      bookingId: current.id,
      user,
      amountPence: refundAmount,
      reason: input.reason || "Booking cancelled",
    });
  }

  const { booking, checkoutIds } = await mapErrors(() =>
    db.transaction(async (tx) => {
      const before = await loadBookingRow(tx, input.bookingId, true);
      assertTransition(before.status, "cancelled");
      const open = before.status === "pending" ? await openCheckoutIds(tx, before) : [];
      const after = await updateBooking(tx, before.id, {
        status: "cancelled",
        cancelledAt: input.now ?? new Date(),
        cancelReason: input.reason.trim() || null,
        paymentStatus: derivePaymentStatus({ ...before, status: "cancelled" }),
      });
      if (before.holdId) {
        await tx
          .update(s.holds)
          .set({ status: "released" })
          .where(and(eq(s.holds.id, before.holdId), eq(s.holds.status, "active")));
      }
      await tx
        .update(s.payments)
        .set({ status: "failed", updatedAt: new Date() })
        .where(and(eq(s.payments.bookingId, before.id), eq(s.payments.status, "pending")));
      await audit(tx, {
        user,
        action: "booking.cancel",
        entityType: "booking",
        entityId: after.id,
        venueId: after.venueId,
        before: pick(before, ["status", "cancelReason", ...STATUS_FIELDS]),
        after: pick(after, ["status", "cancelReason", ...STATUS_FIELDS]),
      });
      return { booking: after, checkoutIds: open };
    }),
  );

  await expireCheckouts(db, booking.venueId, checkoutIds);
  if (current.status !== "pending") {
    await emailCustomer(db, "cancellation email", { bookingId: booking.id, template: "cancellation" });
  }
  await sideEffect("calendar delete", () => syncBookingToCalendar(db, booking.id, "delete"));
  return booking;
}

// ---------- refunds ----------

/**
 * Give money back. Managers and the owner only.
 *
 * Race-safe in three steps: (1) in one transaction the booking row is locked,
 * `paid - refunded` is re-checked and a `pending` refund row is inserted, which
 * reserves the amount (it counts in `refundedPence` straight away, so a second
 * refund at the same moment sees it); (2) online payments are refunded with the
 * payment provider using the refund row's id as the idempotency key; cash and
 * card machine payments are recorded only (the money goes back over the
 * counter); (3) the row is settled to succeeded or failed. A failed refund is
 * not counted: its reservation is given back.
 */
export async function refundBooking(
  db: DbOrTx,
  input: { bookingId: string; user: CurrentUser; amountPence: number; reason: string },
): Promise<s.Refund> {
  const { user } = input;
  const current = await loadBookingRow(db, input.bookingId);
  if (!canRefund(user, current.venueId)) throw new BookingError("FORBIDDEN", "Only a manager or the owner can give a refund.");
  const amount = input.amountPence;
  if (!Number.isInteger(amount) || amount < 1) throw new BookingError("INVALID", "Enter an amount to refund.");
  const venue = await loadVenue(db, current.venueId);
  const resolved = await getPaymentProvider(venue.slug);

  // (1) Reserve.
  const { refund: reserved, payment } = await mapErrors(() =>
    db.transaction(async (tx) => {
      const before = await loadBookingRow(tx, current.id, true);
      const refundable = before.paidPence - before.refundedPence;
      if (refundable <= 0) throw new BookingError("STATE", "There is nothing left to refund on this booking.");
      if (amount > refundable) {
        throw new BookingError("LIMIT", `You can refund up to ${fmtPence(refundable)}.`, { limit: refundable });
      }
      const payments = await tx
        .select()
        .from(s.payments)
        .where(and(eq(s.payments.bookingId, before.id), inArray(s.payments.status, ["succeeded", "partially_refunded", "refunded", "disputed"])))
        .orderBy(asc(s.payments.createdAt));
      const refundedByPayment = await refundedByPaymentId(tx, before.id);
      const candidates = payments
        .map((p) => ({ payment: p, left: p.amountPence - (refundedByPayment.get(p.id) ?? 0) }))
        .filter((c) => c.left > 0)
        // Online card payments first, then the largest.
        .sort((a, b) => Number(isOnline(b.payment)) - Number(isOnline(a.payment)) || b.left - a.left);
      const chosen = candidates.find((c) => c.left >= amount);
      if (!chosen) {
        const most = candidates.reduce((n, c) => Math.max(n, c.left), 0);
        if (most <= 0) throw new BookingError("STATE", "There is no payment on this booking to refund.");
        throw new BookingError("LIMIT", `You can refund up to ${fmtPence(most)} in one go; then refund the rest separately.`, { limit: most });
      }
      if (isOnline(chosen.payment) && !resolved) {
        throw new BookingError("UNAVAILABLE", "Card refunds are not set up for this venue yet (no Stripe key).");
      }
      const [row] = await tx
        .insert(s.refunds)
        .values({
          paymentId: chosen.payment.id,
          bookingId: before.id,
          amountPence: amount,
          reason: input.reason.trim(),
          status: "pending",
          providerRefundId: null,
          createdBy: user.id,
        })
        .returning();
      await syncPaymentRefundStatus(tx, chosen.payment.id);
      const refundedPence = before.refundedPence + amount;
      await updateBooking(tx, before.id, { refundedPence, paymentStatus: derivePaymentStatus({ ...before, refundedPence }) });
      return { refund: row, payment: chosen.payment };
    }),
  );

  // (2) Ask the payment provider.
  let status: s.Refund["status"] = "succeeded";
  let providerRefundId: string | null = null;
  let failure = "The card refund was declined by the payment provider.";
  if (isOnline(payment) && resolved) {
    try {
      const result = await resolved.provider.refund({
        venueSlug: venue.slug,
        providerPaymentIntentId: payment.providerPaymentIntentId,
        providerChargeId: payment.providerChargeId,
        amountPence: amount,
        reason: input.reason,
        idempotencyKey: `refund_${reserved.id}`,
      });
      status = result.status;
      providerRefundId = result.providerRefundId;
    } catch (e) {
      logSideEffectError("provider refund", e);
      status = "failed";
      failure = `The card refund did not go through: ${e instanceof Error ? e.message : "unknown error"}.`;
    }
  }

  // (3) Settle.
  const settled = await settleRefund(db, { refundId: reserved.id, status, providerRefundId, user });
  if (!settled || settled.refund.status === "failed") throw new BookingError("UNAVAILABLE", failure);
  await emailCustomer(db, "refund email", { bookingId: current.id, template: "refund", extra: { refundAmountPence: amount } });
  return settled.refund;
}

function isOnline(p: s.Payment): boolean {
  return p.provider === "stripe" || p.provider === "demo";
}

/** Refunds counted against each payment of a booking (everything but failed ones). */
async function refundedByPaymentId(tx: DbOrTx, bookingId: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({ paymentId: s.refunds.paymentId, amount: s.refunds.amountPence, status: s.refunds.status })
    .from(s.refunds)
    .where(eq(s.refunds.bookingId, bookingId));
  const out = new Map<string, number>();
  for (const r of rows) if (r.status !== "failed") out.set(r.paymentId, (out.get(r.paymentId) ?? 0) + r.amount);
  return out;
}

/** Set a payment's refund state from its counted refunds (a disputed payment stays disputed). */
async function syncPaymentRefundStatus(tx: DbOrTx, paymentId: string): Promise<void> {
  const [payment] = await tx.select().from(s.payments).where(eq(s.payments.id, paymentId)).limit(1);
  if (!payment || !["succeeded", "partially_refunded", "refunded"].includes(payment.status)) return;
  const rows = await tx
    .select({ amount: s.refunds.amountPence, status: s.refunds.status })
    .from(s.refunds)
    .where(eq(s.refunds.paymentId, paymentId));
  const refunded = rows.filter((r) => r.status !== "failed").reduce((n, r) => n + r.amount, 0);
  const status: s.Payment["status"] = refunded <= 0 ? "succeeded" : refunded >= payment.amountPence ? "refunded" : "partially_refunded";
  if (status !== payment.status) {
    await tx.update(s.payments).set({ status, updatedAt: new Date() }).where(eq(s.payments.id, paymentId));
  }
}

/**
 * Move a refund row to a new status (and attach the provider's refund id), keeping
 * the booking's `refundedPence` and payment states in step: a refund that goes to
 * `failed` stops counting, one that comes back from `failed` counts again. Used by
 * `refundBooking` and the `charge.refunded` webhook. Returns null for an unknown id.
 */
export async function settleRefund(
  db: DbOrTx,
  input: { refundId: string; status: s.Refund["status"]; providerRefundId?: string | null; user?: CurrentUser | null },
): Promise<{ refund: s.Refund; booking: s.Booking } | null> {
  if (!isUuid(input.refundId)) return null;
  return db.transaction(async (tx) => {
    const [peek] = await tx.select({ bookingId: s.refunds.bookingId }).from(s.refunds).where(eq(s.refunds.id, input.refundId)).limit(1);
    if (!peek) return null;
    // Lock order: the booking row first, as everywhere else.
    const before = await loadBookingRow(tx, peek.bookingId, true);
    const [row] = await tx.select().from(s.refunds).where(eq(s.refunds.id, input.refundId)).for("update");
    if (!row) return null;

    let status = input.status;
    let providerRefundId = input.providerRefundId ?? row.providerRefundId;
    if (input.providerRefundId && input.providerRefundId !== row.providerRefundId) {
      // The webhook may already have recorded this provider refund as a row of its own.
      const [other] = await tx
        .select({ id: s.refunds.id })
        .from(s.refunds)
        .where(and(eq(s.refunds.providerRefundId, input.providerRefundId), ne(s.refunds.id, row.id)))
        .limit(1);
      if (other) {
        status = "failed";
        providerRefundId = row.providerRefundId;
      }
    }
    if (status === row.status && providerRefundId === row.providerRefundId) return { refund: row, booking: before };

    const [refund] = await tx
      .update(s.refunds)
      .set({ status, providerRefundId, updatedAt: new Date() })
      .where(eq(s.refunds.id, row.id))
      .returning();
    const wasCounted = row.status !== "failed";
    const isCounted = status !== "failed";
    let booking = before;
    if (wasCounted !== isCounted) {
      const refundedPence = Math.max(0, before.refundedPence + (isCounted ? row.amountPence : -row.amountPence));
      booking = await updateBooking(tx, before.id, { refundedPence, paymentStatus: derivePaymentStatus({ ...before, refundedPence }) });
    }
    await syncPaymentRefundStatus(tx, row.paymentId);
    if (row.status !== status) {
      await audit(tx, {
        user: input.user ?? null,
        action: status === "failed" ? "booking.refund_failed" : "booking.refund",
        entityType: "booking",
        entityId: before.id,
        venueId: before.venueId,
        before: { ...pick(before, STATUS_FIELDS), refundStatus: row.status },
        after: { ...pick(booking, STATUS_FIELDS), refundId: row.id, refundStatus: status, amountPence: row.amountPence, reason: row.reason },
      });
    }
    return { refund, booking };
  });
}

/**
 * Apply a refund made outside BayPook (Stripe dashboard), found by the
 * charge.refunded webhook. Returns null when the payment is unknown or the
 * provider refund id is already recorded (the unique index on it).
 */
export async function recordProviderRefund(
  db: DbOrTx,
  input: { paymentId: string; amountPence: number; providerRefundId: string; status: s.Refund["status"]; reason?: string },
): Promise<{ refund: s.Refund; booking: s.Booking } | null> {
  let result: { refund: s.Refund; booking: s.Booking } | null;
  try {
    result = await db.transaction(async (tx) => {
      const [payment] = await tx.select().from(s.payments).where(eq(s.payments.id, input.paymentId)).limit(1);
      if (!payment) return null;
      const before = await loadBookingRow(tx, payment.bookingId, true);
      const [row] = await tx
        .insert(s.refunds)
        .values({
          paymentId: payment.id,
          bookingId: before.id,
          amountPence: input.amountPence,
          reason: input.reason ?? "Refunded in the payment provider's dashboard",
          status: input.status,
          providerRefundId: input.providerRefundId,
          createdBy: null,
        })
        .returning();
      if (input.status === "failed") return { refund: row, booking: before };
      await syncPaymentRefundStatus(tx, payment.id);
      const refundedPence = before.refundedPence + input.amountPence;
      const after = await updateBooking(tx, before.id, {
        refundedPence,
        paymentStatus: derivePaymentStatus({ ...before, refundedPence }),
      });
      await audit(tx, {
        user: null,
        action: "booking.refund_external",
        entityType: "booking",
        entityId: before.id,
        venueId: before.venueId,
        before: pick(before, STATUS_FIELDS),
        after: { ...pick(after, STATUS_FIELDS), refundId: row.id, providerRefundId: input.providerRefundId, amountPence: input.amountPence },
      });
      return { refund: row, booking: after };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
  if (result && result.refund.status !== "failed") {
    await emailCustomer(db, "refund email", { bookingId: result.booking.id, template: "refund", extra: { refundAmountPence: input.amountPence } });
  }
  return result;
}

// ---------- changes ----------

/**
 * Move to another session (sessions) or start time (slots). Capacity and room
 * conflicts are checked (excluding this booking); lead time and cut-off are not,
 * since staff may move a booking at short notice.
 */
export async function moveBooking(
  db: DbOrTx,
  input: { bookingId: string; user: CurrentUser; sessionId?: string | null; startsAt?: Date | null; now?: Date },
): Promise<s.Booking> {
  const { user } = input;
  const current = await loadBookingRow(db, input.bookingId);
  requireAccess(user, current.venueId);
  if (current.status !== "confirmed") throw new BookingError("STATE", "Only a confirmed booking can be moved.");
  const venue = await loadVenue(db, current.venueId);
  const service = await loadService(db, current.serviceId);
  const org = await getOrganisation(db);
  const tz = org.timezone || DEFAULT_TZ;
  const now = input.now ?? new Date();

  let startsAt: Date;
  let endsAt: Date;
  let roomId = service.roomId;
  if (service.kind === "session") {
    if (!isUuid(input.sessionId)) throw new BookingError("INVALID", "Choose the session to move to.");
    const [session] = await db.select().from(s.sessions).where(eq(s.sessions.id, input.sessionId)).limit(1);
    if (!session || session.serviceId !== service.id) throw new BookingError("INVALID", "That session is not part of this service.");
    startsAt = session.startsAt;
    endsAt = session.endsAt;
    roomId = session.roomId;
  } else {
    const st = input.startsAt;
    if (!(st instanceof Date) || Number.isNaN(st.getTime())) throw new BookingError("INVALID", "Choose the new start time.");
    startsAt = st;
    endsAt = new Date(st.getTime() + (current.endsAt.getTime() - current.startsAt.getTime()));
    await ensureSessionsAround(db, venue.id, startsAt, endsAt, tz);
  }

  const booking = await mapErrors(() =>
    db.transaction(async (tx) => {
      // Lock order everywhere: booking row, then session, then room (assertBookable).
      const before = await loadBookingRow(tx, current.id, true);
      if (before.status !== "confirmed") throw new BookingError("STATE", "Only a confirmed booking can be moved.");
      const slot = await assertBookable(tx, {
        venue,
        service,
        sessionId: service.kind === "session" ? input.sessionId : null,
        startsAt,
        endsAt,
        places: before.places,
        now,
        tz,
        excludeBookingId: before.id,
        ignoreTiming: true,
      });
      const after = await updateBooking(tx, before.id, {
        sessionId: slot.sessionId,
        roomId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        reminderSentAt: null,
      });
      await audit(tx, {
        user,
        action: "booking.move",
        entityType: "booking",
        entityId: after.id,
        venueId: after.venueId,
        before: pick(before, ["sessionId", "roomId", "startsAt", "endsAt"]),
        after: pick(after, ["sessionId", "roomId", "startsAt", "endsAt"]),
      });
      return after;
    }),
  );

  await emailCustomer(db, "confirmation email (moved)", { bookingId: booking.id, template: "confirmation" });
  await sideEffect("calendar update", () => syncBookingToCalendar(db, booking.id, "update"));
  return booking;
}

/**
 * Change places, options or add-ons. Re-checks capacity (excluding this booking).
 * Items already on the booking keep the unit price they were sold at (quantities
 * up or down; archived items already on it stay allowed); only places beyond
 * what was sold, and new items, are priced from today's catalogue. A higher total
 * leaves the difference owed (to pay in store); a lower one leaves the booking
 * paid and returns a negative delta so the admin can offer a refund.
 */
export async function changeBookingCounts(
  db: DbOrTx,
  input: {
    bookingId: string;
    user: CurrentUser;
    lines: { optionId: string; qty: number }[];
    addOns: { addOnId: string; qty: number }[];
    now?: Date;
  },
): Promise<{ booking: s.Booking; delta: number }> {
  const { user } = input;
  const current = await loadBookingRow(db, input.bookingId);
  requireAccess(user, current.venueId);
  if (current.status !== "confirmed") throw new BookingError("STATE", "Only a confirmed booking can be changed.");
  const venue = await loadVenue(db, current.venueId);
  const service = await loadService(db, current.serviceId);
  const org = await getOrganisation(db);
  const tz = org.timezone || DEFAULT_TZ;
  const now = input.now ?? new Date();

  return mapErrors(async () => {
    // Times do not depend on prices: work out the new end (and its sessions) before locking.
    const draft = requoteKeepingPrices(service, venue, current, input.lines, input.addOns);
    const draftEndsAt = service.kind === "slot" ? addMinutes(current.startsAt, service.lengthMinutes + draft.extraMinutes) : current.endsAt;
    if (service.kind === "slot") await ensureSessionsAround(db, venue.id, current.startsAt, draftEndsAt, tz);

    const booking = await db.transaction(async (tx) => {
      // Lock order everywhere: booking row, then session, then room (assertBookable).
      const before = await loadBookingRow(tx, current.id, true);
      if (before.status !== "confirmed") throw new BookingError("STATE", "Only a confirmed booking can be changed.");
      const q = requoteKeepingPrices(service, venue, before, input.lines, input.addOns);
      const endsAt = service.kind === "slot" ? addMinutes(before.startsAt, service.lengthMinutes + q.extraMinutes) : before.endsAt;
      await assertBookable(tx, {
        venue,
        service,
        sessionId: before.sessionId,
        startsAt: before.startsAt,
        endsAt,
        places: q.places,
        now,
        tz,
        excludeBookingId: before.id,
        ignoreTiming: true,
      });
      const next = { ...before, totalPence: q.totalPence };
      const after = await updateBooking(tx, before.id, {
        lines: q.lines,
        addOns: q.addOns,
        places: q.places,
        subtotalPence: q.subtotalPence,
        totalPence: q.totalPence,
        endsAt,
        paymentStatus: derivePaymentStatus(next),
      });
      await audit(tx, {
        user,
        action: "booking.change_counts",
        entityType: "booking",
        entityId: after.id,
        venueId: after.venueId,
        before: pick(before, ["lines", "addOns", "places", "totalPence", "endsAt", "paymentStatus"]),
        after: pick(after, ["lines", "addOns", "places", "totalPence", "endsAt", "paymentStatus"]),
      });
      return after;
    });
    await sideEffect("calendar update", () => syncBookingToCalendar(db, booking.id, "update"));
    return { booking, delta: booking.totalPence - (booking.paidPence - booking.refundedPence) };
  });
}

/**
 * Split `qty` over the price tranches already sold (oldest first), and price any
 * places beyond them at today's price. Tranches with the same price merge.
 */
export function keepSoldPrices(qty: number, todayPence: number, sold: { qty: number; unitPence: number }[]): { qty: number; unitPence: number }[] {
  const out: { qty: number; unitPence: number }[] = [];
  const push = (n: number, unitPence: number) => {
    if (n <= 0) return;
    const same = out.find((x) => x.unitPence === unitPence);
    if (same) same.qty += n;
    else out.push({ qty: n, unitPence });
  };
  let left = qty;
  for (const t of sold) {
    if (left <= 0) break;
    const n = Math.min(Math.max(0, t.qty), left);
    push(n, t.unitPence);
    left -= n;
  }
  push(left, todayPence);
  return out;
}

/**
 * Quote a change to a booking: today's catalogue checks the rules (limits,
 * places, extra minutes), items already on the booking may be archived, and
 * their sold quantities keep their sold unit prices (`keepSoldPrices`). An item
 * sold at two prices becomes two lines.
 */
function requoteKeepingPrices(
  service: ServiceWithCatalogue,
  venue: s.Venue,
  booking: Pick<s.Booking, "lines" | "addOns">,
  lines: { optionId: string; qty: number }[],
  addOns: { addOnId: string; qty: number }[],
): Quote {
  const soldOptions = new Set(booking.lines.map((l) => l.optionId));
  const soldAddOns = new Set(booking.addOns.map((a) => a.addOnId));
  const catalogue: ServiceWithCatalogue = {
    ...service,
    options: service.options.map((o) => (soldOptions.has(o.id) ? { ...o, archivedAt: null } : o)),
    addOns: service.addOns.map((a) => (soldAddOns.has(a.id) ? { ...a, archivedAt: null } : a)),
  };
  const q = quoteForService(null, { service: catalogue, venue, lines, addOns });
  const outLines = q.lines.flatMap((l) =>
    keepSoldPrices(
      l.qty,
      l.unitPence,
      booking.lines.filter((x) => x.optionId === l.optionId),
    ).map((t) => ({ ...l, qty: t.qty, unitPence: t.unitPence, totalPence: t.qty * t.unitPence })),
  );
  const outAddOns = q.addOns.flatMap((a) => {
    const minutesEach = a.qty > 0 ? a.extraMinutes / a.qty : 0;
    return keepSoldPrices(
      a.qty,
      a.unitPence,
      booking.addOns.filter((x) => x.addOnId === a.addOnId),
    ).map((t) => ({ ...a, qty: t.qty, unitPence: t.unitPence, totalPence: t.qty * t.unitPence, extraMinutes: minutesEach * t.qty }));
  });
  const subtotalPence = outLines.reduce((n, l) => n + l.totalPence, 0) + outAddOns.reduce((n, a) => n + a.totalPence, 0);
  return { ...q, lines: outLines, addOns: outAddOns, subtotalPence, totalPence: subtotalPence };
}

/** Record money taken in store (cash or the card machine). */
export async function markPaidInStore(
  db: DbOrTx,
  input: { bookingId: string; user: CurrentUser; method: "cash" | "card_machine"; amountPence: number },
): Promise<s.Payment> {
  const { user } = input;
  const current = await loadBookingRow(db, input.bookingId);
  requireAccess(user, current.venueId);
  if (!Number.isInteger(input.amountPence) || input.amountPence < 1) throw new BookingError("INVALID", "Enter the amount taken.");
  if (current.status === "pending" || current.status === "cancelled") {
    throw new BookingError("STATE", "Only a confirmed booking can be marked as paid.");
  }
  if (input.method !== "cash" && input.method !== "card_machine") throw new BookingError("INVALID", "Choose cash or card machine.");

  return db.transaction(async (tx) => {
    const before = await loadBookingRow(tx, current.id, true);
    const [payment] = await tx
      .insert(s.payments)
      .values({
        bookingId: before.id,
        venueId: before.venueId,
        provider: "manual",
        amountPence: input.amountPence,
        currency: "gbp",
        status: "succeeded",
        method: input.method,
        createdBy: user.id,
      })
      .returning();
    const paidPence = before.paidPence + input.amountPence;
    const after = await updateBooking(tx, before.id, { paidPence, paymentStatus: derivePaymentStatus({ ...before, paidPence }) });
    await audit(tx, {
      user,
      action: "booking.paid_in_store",
      entityType: "booking",
      entityId: before.id,
      venueId: before.venueId,
      before: pick(before, STATUS_FIELDS),
      after: { ...pick(after, STATUS_FIELDS), paymentId: payment.id, method: input.method, amountPence: input.amountPence },
    });
    return payment;
  });
}

/** confirmed -> no-show, or back again with `undo`. */
export async function markNoShow(
  db: DbOrTx,
  input: { bookingId: string; user: CurrentUser; undo?: boolean },
): Promise<s.Booking> {
  const { user } = input;
  const current = await loadBookingRow(db, input.bookingId);
  requireAccess(user, current.venueId);
  // A no-show's places are free for others; taking them back needs them to still be free.
  const venue = input.undo ? await loadVenue(db, current.venueId) : null;
  const service = input.undo ? await loadService(db, current.serviceId) : null;
  return mapErrors(() =>
    db.transaction(async (tx) => {
      const before = await loadBookingRow(tx, current.id, true);
      const to: BookingStatus = input.undo ? "confirmed" : "no_show";
      assertTransition(before.status, to);
      if (venue && service) {
        await assertBookable(tx, {
          venue,
          service,
          sessionId: before.sessionId,
          startsAt: before.startsAt,
          endsAt: before.endsAt,
          places: before.places,
          excludeBookingId: before.id,
          ignoreTiming: true,
        });
      }
      const after = await updateBooking(tx, before.id, { status: to, noShowAt: input.undo ? null : new Date() });
      await audit(tx, {
        user,
        action: input.undo ? "booking.no_show_undo" : "booking.no_show",
        entityType: "booking",
        entityId: after.id,
        venueId: after.venueId,
        before: pick(before, ["status", "noShowAt"]),
        after: pick(after, ["status", "noShowAt"]),
      });
      return after;
    }),
  );
}

/** Replace the internal notes (allergies, anything the parent said). */
export async function addBookingNote(
  db: DbOrTx,
  input: { bookingId: string; user: CurrentUser; notes: string },
): Promise<s.Booking> {
  const { user } = input;
  const current = await loadBookingRow(db, input.bookingId);
  requireAccess(user, current.venueId);
  const notes = input.notes.trim();
  if (notes.length > 5000) throw new BookingError("INVALID", "Notes can be up to 5,000 characters.");
  const booking = await db.transaction(async (tx) => {
    const before = await loadBookingRow(tx, current.id, true);
    const after = await updateBooking(tx, before.id, { notes: notes || null });
    await audit(tx, {
      user,
      action: "booking.note",
      entityType: "booking",
      entityId: after.id,
      venueId: after.venueId,
      before: pick(before, ["notes"]),
      after: pick(after, ["notes"]),
    });
    return after;
  });
  await sideEffect("calendar update", () => syncBookingToCalendar(db, booking.id, "update"));
  return booking;
}

/** Send the confirmation email again (with the .ics). */
export async function resendConfirmation(
  db: DbOrTx,
  input: { bookingId: string; user: CurrentUser },
): Promise<s.Notification> {
  const { user } = input;
  const booking = await loadBookingRow(db, input.bookingId);
  requireAccess(user, booking.venueId);
  if (booking.status !== "confirmed" && booking.status !== "no_show") {
    throw new BookingError("STATE", "Only a confirmed booking has a confirmation to send.");
  }
  const [customer] = await db.select().from(s.customers).where(eq(s.customers.id, booking.customerId)).limit(1);
  if (!customer?.email) throw new BookingError("INVALID", "This customer has no e-mail address.");
  const notification = await sendBookingEmail(db, { bookingId: booking.id, template: "confirmation" });
  await audit(db, {
    user,
    action: "booking.resend_confirmation",
    entityType: "booking",
    entityId: booking.id,
    venueId: booking.venueId,
    before: null,
    after: { notificationId: notification.id, status: notification.status, to: notification.toAddress },
  });
  return notification;
}

/**
 * A walk-in or phone booking made by staff: confirmed immediately. Lead time and
 * cut-off do not apply (staff may book at short notice); capacity and room rules do.
 */
export async function createManualBooking(
  db: DbOrTx,
  input: {
    user: CurrentUser;
    venue: s.Venue;
    service: ServiceWithCatalogue;
    sessionId?: string | null;
    startsAt?: Date | null;
    lines: { optionId: string; qty: number }[];
    addOns: { addOnId: string; qty: number }[];
    customer: { firstName: string; lastName: string; email?: string | null; phone?: string | null };
    /** Reuse an existing customer (e.g. picked from the typeahead) instead of matching by email. */
    customerId?: string | null;
    birthdayChild?: { firstName: string; age?: number | null } | null;
    notes?: string | null;
    /**
     * How they paid. `imported`: money taken by the system the booking was imported
     * from (a payment row from provider `import` when `amountPence` > 0).
     */
    payment: { method: "cash" | "card_machine" | "pay_in_store" | "imported"; amountPence?: number | null };
    sendEmail: boolean;
    /** "import" for bookings brought over from another system (with `externalRef`). Default "manual". */
    source?: "manual" | "import";
    /** The booking's reference in the system it was imported from. */
    externalRef?: string | null;
    now?: Date;
  },
): Promise<s.Booking> {
  const { user, venue, service } = input;
  requireAccess(user, venue.id);
  if (service.venueId !== venue.id) throw new BookingError("INVALID", "That service is not offered at this venue.");
  const firstName = input.customer.firstName?.trim() ?? "";
  if (!firstName) throw new BookingError("INVALID", "Enter the customer's first name.");
  const method = input.payment.method;
  if (!["cash", "card_machine", "pay_in_store", "imported"].includes(method)) throw new BookingError("INVALID", "Choose how they are paying.");
  const source = input.source ?? "manual";
  if (source !== "manual" && source !== "import") throw new BookingError("INVALID", "Unknown booking source.");
  const externalRef = input.externalRef?.trim() || null;
  const org = await getOrganisation(db);
  const tz = org.timezone || DEFAULT_TZ;
  const now = input.now ?? new Date();

  const result = await mapErrors(async () => {
    const q = quoteForService(null, { service, venue, lines: input.lines, addOns: input.addOns });
    let startsAt: Date;
    let endsAt: Date;
    if (service.kind === "session") {
      if (!isUuid(input.sessionId)) throw new BookingError("INVALID", "Choose a session time.");
      startsAt = now;
      endsAt = now;
    } else {
      const st = input.startsAt;
      if (!(st instanceof Date) || Number.isNaN(st.getTime())) throw new BookingError("INVALID", "Choose a start time.");
      startsAt = st;
      endsAt = addMinutes(st, service.lengthMinutes + q.extraMinutes);
      await ensureSessionsAround(db, venue.id, startsAt, endsAt, tz);
    }
    const amountPaid =
      method === "pay_in_store" ? 0 : method === "imported" ? (input.payment.amountPence ?? 0) : (input.payment.amountPence ?? q.totalPence);
    if (!Number.isInteger(amountPaid) || amountPaid < 0) throw new BookingError("INVALID", "Enter the amount taken.");

    return db.transaction(async (tx) => {
      const slot = await assertBookable(tx, {
        venue,
        service,
        sessionId: service.kind === "session" ? input.sessionId : null,
        startsAt,
        endsAt,
        places: q.places,
        now,
        tz,
        ignoreTiming: true,
      });
      let roomId = service.roomId;
      if (slot.sessionId) {
        const [session] = await tx.select({ roomId: s.sessions.roomId }).from(s.sessions).where(eq(s.sessions.id, slot.sessionId)).limit(1);
        if (session) roomId = session.roomId;
      }
      let customer: s.Customer | undefined;
      if (isUuid(input.customerId)) {
        [customer] = await tx
          .select()
          .from(s.customers)
          .where(and(eq(s.customers.id, input.customerId as string), eq(s.customers.organisationId, org.id)))
          .limit(1);
      }
      if (!customer) {
        customer = await findOrCreateCustomer(tx, {
          organisationId: org.id,
          firstName,
          lastName: input.customer.lastName ?? "",
          email: input.customer.email ?? "",
          phone: input.customer.phone ?? null,
        });
      }
      const isSlot = service.kind === "slot";
      const booking = await insertBooking(tx, {
        venueId: venue.id,
        serviceId: service.id,
        roomId,
        sessionId: slot.sessionId,
        customerId: customer.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        status: "confirmed",
        lines: q.lines,
        addOns: q.addOns,
        places: q.places,
        subtotalPence: q.subtotalPence,
        totalPence: q.totalPence,
        paidPence: amountPaid,
        refundedPence: 0,
        birthdayChildFirstName: isSlot ? input.birthdayChild?.firstName?.trim() || null : null,
        birthdayChildAge: isSlot ? (input.birthdayChild?.age ?? null) : null,
        source,
        paymentMethod: method,
        paymentStatus: derivePaymentStatus({ totalPence: q.totalPence, paidPence: amountPaid, refundedPence: 0, paymentMethod: method }),
        notes: input.notes?.trim() || null,
        externalRef,
        createdBy: user.id,
      });
      if (amountPaid > 0 && method !== "pay_in_store") {
        await tx.insert(s.payments).values({
          bookingId: booking.id,
          venueId: venue.id,
          provider: method === "imported" ? "import" : "manual",
          amountPence: amountPaid,
          currency: org.currency,
          status: "succeeded",
          method,
          createdBy: user.id,
        });
      }
      await audit(tx, {
        user,
        action: source === "import" ? "booking.import" : "booking.create_manual",
        entityType: "booking",
        entityId: booking.id,
        venueId: venue.id,
        before: null,
        after: {
          ...pick(booking, ["reference", "status", "paymentStatus", "paymentMethod", "totalPence", "paidPence", "places", "startsAt", "endsAt"]),
          ...(externalRef ? { externalRef } : {}),
        },
      });
      return { booking, customerEmail: customer.email };
    });
  });

  const { booking } = result;
  if (input.sendEmail && result.customerEmail) {
    await sideEffect("confirmation email", () => sendBookingEmail(db, { bookingId: booking.id, template: "confirmation" }));
  }
  await sideEffect("calendar create", () => syncBookingToCalendar(db, booking.id, "create"));
  return booking;
}

// ---------- reads ----------

export type BookingDetail = {
  booking: s.Booking;
  customer: s.Customer;
  service: s.Service;
  venue: s.Venue;
  room: s.Room;
  payments: s.Payment[];
  refunds: s.Refund[];
  notifications: s.Notification[];
  calendarLog: s.CalendarLogRow[];
};

export async function getBookingDetail(db: DbOrTx, id: string): Promise<BookingDetail | null> {
  if (!isUuid(id)) return null;
  const [booking] = await db.select().from(s.bookings).where(eq(s.bookings.id, id)).limit(1);
  if (!booking) return null;
  const [[customer], [service], [venue], [room], payments, refunds, notifications, calendarLog] = await Promise.all([
    db.select().from(s.customers).where(eq(s.customers.id, booking.customerId)).limit(1),
    db.select().from(s.services).where(eq(s.services.id, booking.serviceId)).limit(1),
    db.select().from(s.venues).where(eq(s.venues.id, booking.venueId)).limit(1),
    db.select().from(s.rooms).where(eq(s.rooms.id, booking.roomId)).limit(1),
    db.select().from(s.payments).where(eq(s.payments.bookingId, id)).orderBy(asc(s.payments.createdAt)),
    db.select().from(s.refunds).where(eq(s.refunds.bookingId, id)).orderBy(asc(s.refunds.createdAt)),
    db.select().from(s.notifications).where(eq(s.notifications.bookingId, id)).orderBy(desc(s.notifications.createdAt)),
    db.select().from(s.calendarLog).where(eq(s.calendarLog.bookingId, id)).orderBy(desc(s.calendarLog.createdAt)),
  ]);
  if (!customer || !service || !venue || !room) return null;
  return { booking, customer, service, venue, room, payments, refunds, notifications, calendarLog };
}

export type BookingListItem = {
  booking: s.Booking;
  customer: Pick<s.Customer, "id" | "firstName" | "lastName" | "email" | "phone">;
  service: Pick<s.Service, "id" | "name" | "kind" | "colour">;
  venue: Pick<s.Venue, "id" | "name" | "slug">;
};

/**
 * Bookings for lists and reports. `venueIds: null` = every venue (owner); an array
 * limits to those venues. `from`/`to` filter on the start (half-open). `search`
 * matches the reference, the customer's name, e-mail or phone.
 */
export async function listBookings(
  db: DbOrTx,
  opts: {
    venueIds: string[] | null;
    from?: Date;
    to?: Date;
    status?: BookingStatus | BookingStatus[];
    search?: string;
    limit?: number;
    offset?: number;
    order?: "asc" | "desc";
  },
): Promise<BookingListItem[]> {
  const where: (SQL | undefined)[] = [];
  if (Array.isArray(opts.venueIds)) {
    if (opts.venueIds.length === 0) return [];
    where.push(inArray(s.bookings.venueId, opts.venueIds));
  }
  if (opts.from) where.push(gte(s.bookings.startsAt, opts.from));
  if (opts.to) where.push(lt(s.bookings.startsAt, opts.to));
  if (opts.status) {
    const list = Array.isArray(opts.status) ? opts.status : [opts.status];
    if (list.length) where.push(inArray(s.bookings.status, list));
  }
  const q = opts.search?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      or(
        ilike(s.bookings.reference, like),
        ilike(s.customers.firstName, like),
        ilike(s.customers.lastName, like),
        ilike(s.customers.email, like),
        ilike(s.customers.phone, like),
        sql`(${s.customers.firstName} || ' ' || ${s.customers.lastName}) ilike ${like}`,
      ),
    );
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await db
    .select({
      booking: s.bookings,
      customer: {
        id: s.customers.id,
        firstName: s.customers.firstName,
        lastName: s.customers.lastName,
        email: s.customers.email,
        phone: s.customers.phone,
      },
      service: { id: s.services.id, name: s.services.name, kind: s.services.kind, colour: s.services.colour },
      venue: { id: s.venues.id, name: s.venues.name, slug: s.venues.slug },
    })
    .from(s.bookings)
    .innerJoin(s.customers, eq(s.customers.id, s.bookings.customerId))
    .innerJoin(s.services, eq(s.services.id, s.bookings.serviceId))
    .innerJoin(s.venues, eq(s.venues.id, s.bookings.venueId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(opts.order === "desc" ? desc(s.bookings.startsAt) : asc(s.bookings.startsAt), asc(s.bookings.createdAt))
    .limit(limit)
    .offset(offset);
  return rows;
}

export type BookingSummaryItem = { name: string; qty: number; unitPence: number; totalPence: number };

/** The thank-you page's view of a booking (docs/API.md). */
export type BookingSummary = {
  reference: string;
  status: s.Booking["status"];
  paymentStatus: s.Booking["paymentStatus"];
  venue: { slug: string; name: string; address: string; postcode: string; mapsUrl: string | null; parkingNotes: string | null };
  service: { name: string; kind: s.Service["kind"] };
  startsAt: string;
  endsAt: string;
  lines: BookingSummaryItem[];
  addOns: BookingSummaryItem[];
  totalPence: number;
  paidPence: number;
  customer: { firstName: string };
  inStoreNote: string | null;
  paymentMethod: s.Booking["paymentMethod"];
  /** The organisation timezone, for showing the date and time. */
  timezone: string;
};

export async function getBookingSummaryByToken(db: DbOrTx, token: string): Promise<BookingSummary | null> {
  if (typeof token !== "string" || token.length < 16 || token.length > 200) return null;
  const [row] = await db
    .select({
      booking: s.bookings,
      venue: s.venues,
      service: s.services,
      firstName: s.customers.firstName,
      timezone: s.organisations.timezone,
    })
    .from(s.bookings)
    .innerJoin(s.venues, eq(s.venues.id, s.bookings.venueId))
    .innerJoin(s.services, eq(s.services.id, s.bookings.serviceId))
    .innerJoin(s.customers, eq(s.customers.id, s.bookings.customerId))
    .innerJoin(s.organisations, eq(s.organisations.id, s.venues.organisationId))
    .where(eq(s.bookings.token, token))
    .limit(1);
  if (!row) return null;
  const { booking, venue, service } = row;
  const optionIds = booking.lines.map((l) => l.optionId).filter(isUuid);
  const options = optionIds.length
    ? await db.select().from(s.serviceOptions).where(inArray(s.serviceOptions.id, optionIds))
    : [];
  const notes: string[] = [];
  const push = (n: string | null | undefined) => {
    const t = n?.trim();
    if (t && !notes.includes(t)) notes.push(t);
  };
  for (const line of booking.lines) {
    if (line.qty <= 0) continue;
    const o = options.find((x) => x.id === line.optionId);
    push(o?.inStoreNoteShort ?? o?.inStoreNoteLine);
  }
  push(service.inStoreNoteShort ?? service.inStoreNoteLine);

  const item = (x: { name: string; qty: number; unitPence: number; totalPence: number }): BookingSummaryItem => ({
    name: x.name,
    qty: x.qty,
    unitPence: x.unitPence,
    totalPence: x.totalPence,
  });
  return {
    reference: booking.reference,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    venue: {
      slug: venue.slug,
      name: venue.name,
      address: venue.address,
      postcode: venue.postcode ?? "",
      mapsUrl: venue.mapsUrl,
      parkingNotes: venue.parkingNotes,
    },
    service: { name: service.name, kind: service.kind },
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    lines: booking.lines.map(item),
    addOns: booking.addOns.map(item),
    totalPence: booking.totalPence,
    paidPence: booking.paidPence,
    customer: { firstName: row.firstName },
    inStoreNote: notes.length ? notes.join(" ") : null,
    paymentMethod: booking.paymentMethod,
    timezone: row.timezone || DEFAULT_TZ,
  };
}

/** Find a booking by its payment provider checkout id (webhooks). */
export async function findBookingIdByCheckout(db: DbOrTx, checkoutId: string): Promise<string | null> {
  const [p] = await db
    .select({ bookingId: s.payments.bookingId })
    .from(s.payments)
    .where(eq(s.payments.providerCheckoutId, checkoutId))
    .limit(1);
  if (p) return p.bookingId;
  const [h] = await db
    .select({ bookingId: s.holds.bookingId })
    .from(s.holds)
    .where(and(eq(s.holds.checkoutId, checkoutId), ne(s.holds.status, "released")))
    .limit(1);
  return h?.bookingId ?? null;
}

/** Shared by emails and checkout descriptions: "Classic Workshops, Saturday 24 October 2026 at 14:00". */
export function describeBooking(serviceName: string, startsAt: Date, tz = DEFAULT_TZ): string {
  return `${serviceName}, ${fmtDayLong(startsAt, tz)} at ${fmtTime(startsAt, tz)}`;
}

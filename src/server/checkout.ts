/**
 * Checkout: turns an active hold into a pending booking and a payment page.
 *
 * The booking is only ever confirmed by the payment provider's webhook (or, in
 * demo mode, by the fake checkout page running the same confirmation code); the
 * return URL just shows the customer the thank-you page.
 */
import { and, eq } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { DEFAULT_TZ } from "@/core/time";
import { env, isDemo } from "@/lib/env";
import { getPaymentProvider } from "@/providers";
import type { CheckoutLineItem } from "@/providers/types";
import { getActiveHold, HoldError, lockActiveHold, releaseHold, setHoldCheckout } from "./holds";
import { getService } from "./catalogue";
import { quoteForService } from "./quote";
import { getOrganisation } from "./org";
import {
  BookingError,
  cancelPendingBooking,
  createPendingBookingFromHold,
  describeBooking,
  toBookingError,
  type BookingCustomerInput,
} from "./bookings";
import { sendBookingEmail } from "./notifications";
import { syncBookingToCalendar } from "./calendar";
import { audit } from "./audit";

export type StartCheckoutInput = {
  holdId: string;
  customer: BookingCustomerInput & { phone: string };
  birthdayChild?: { firstName: string; age: number } | null;
  message?: string | null;
  accept: { terms: boolean; waiver: boolean };
  returnUrl?: string | null;
  payInStore?: boolean;
  /** The calling page's origin (informational; the return URL decides where customers go back to). */
  origin?: string | null;
  now?: Date;
};

export type OnlineCheckoutResult = { bookingId: string; reference: string; checkoutUrl: string };
export type PayInStoreCheckoutResult = { bookingId: string; reference: string; token: string; confirmed: true; thanksUrl: string };
export type StartCheckoutResult = OnlineCheckoutResult | PayInStoreCheckoutResult;

// ---------- return URLs ----------

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Where the customer goes back to: `returnUrl` when it is on an allowed origin
 * (or BayPook itself), otherwise `WEBSITE_URL` (or BayPook) + `/book/thanks`.
 */
export function chooseReturnBase(returnUrl?: string | null): string {
  if (returnUrl) {
    const origin = originOf(returnUrl);
    const allowed = new Set([...env.allowedOrigins(), originOf(env.baseUrl())].filter((x): x is string => Boolean(x)));
    if (origin && allowed.has(origin)) {
      const u = new URL(returnUrl);
      u.hash = "";
      return u.toString();
    }
  }
  const site = (env.websiteUrl() ?? env.baseUrl()).replace(/\/+$/, "");
  return `${site}/book/thanks`;
}

function withParams(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export type ReturnUrls = { base: string; successUrl: string; cancelUrl: string; thanksUrl: string };

export function buildReturnUrls(input: { returnUrl?: string | null; venueSlug: string; token: string }): ReturnUrls {
  const base = chooseReturnBase(input.returnUrl);
  return {
    base,
    successUrl: withParams(base, { paid: "1", venue: input.venueSlug, booking: input.token }),
    cancelUrl: withParams(base, { cancelled: "1", venue: input.venueSlug }),
    thanksUrl: withParams(base, { paid: "0", venue: input.venueSlug, booking: input.token }),
  };
}

// ---------- demo checkout return URLs (settings table, demo mode only) ----------

const DEMO_KEY = (bookingId: string) => `demo.checkout.${bookingId}`;

export async function saveDemoReturnUrls(db: DbOrTx, bookingId: string, urls: { successUrl: string; cancelUrl: string }): Promise<void> {
  await db
    .insert(s.settings)
    .values({ key: DEMO_KEY(bookingId), value: urls })
    .onConflictDoUpdate({ target: s.settings.key, set: { value: urls, updatedAt: new Date() } });
}

/** The demo checkout's success/cancel URLs; recomputed from defaults when none were stored. */
export async function getDemoReturnUrls(
  db: DbOrTx,
  bookingId: string,
  opts: { remove?: boolean } = {},
): Promise<{ successUrl: string; cancelUrl: string }> {
  const [row] = await db.select().from(s.settings).where(eq(s.settings.key, DEMO_KEY(bookingId))).limit(1);
  const v = row?.value as { successUrl?: unknown; cancelUrl?: unknown } | null | undefined;
  if (opts.remove && row) await db.delete(s.settings).where(eq(s.settings.key, DEMO_KEY(bookingId)));
  if (v && typeof v.successUrl === "string" && typeof v.cancelUrl === "string") {
    return { successUrl: v.successUrl, cancelUrl: v.cancelUrl };
  }
  const [b] = await db
    .select({ token: s.bookings.token, slug: s.venues.slug })
    .from(s.bookings)
    .innerJoin(s.venues, eq(s.venues.id, s.bookings.venueId))
    .where(eq(s.bookings.id, bookingId))
    .limit(1);
  const urls = buildReturnUrls({ venueSlug: b?.slug ?? "", token: b?.token ?? "" });
  return { successUrl: urls.successUrl, cancelUrl: urls.cancelUrl };
}

// ---------- checkout ----------

function cleanCustomer(c: StartCheckoutInput["customer"]): StartCheckoutInput["customer"] {
  return {
    firstName: (c.firstName ?? "").trim(),
    lastName: (c.lastName ?? "").trim(),
    email: (c.email ?? "").trim(),
    phone: (c.phone ?? "").trim(),
  };
}

export async function startCheckout(db: Db, input: StartCheckoutInput): Promise<StartCheckoutResult> {
  const now = input.now ?? new Date();
  if (!input.accept?.terms || !input.accept?.waiver) {
    throw new BookingError("INVALID", "Please accept the terms and the waiver.");
  }
  const customer = cleanCustomer(input.customer);
  if (!customer.firstName || !customer.lastName) throw new BookingError("INVALID", "Please enter your first and last name.");
  if (!customer.email.includes("@")) throw new BookingError("INVALID", "Please enter a valid e-mail address.");

  const hold = await getActiveHold(db, input.holdId, now);
  const [venue] = await db.select().from(s.venues).where(eq(s.venues.id, hold.venueId)).limit(1);
  const service = await getService(db, hold.serviceId, { includeArchived: true });
  if (!venue || !service) throw new BookingError("NOT_FOUND", "We could not find that booking in progress.");
  if (venue.status === "closed") throw new BookingError("UNAVAILABLE", "This venue is not taking bookings online right now.");
  const organisation = await getOrganisation(db);
  const tz = organisation.timezone || DEFAULT_TZ;
  if (hold.sessionId) {
    // The owner cancelled this time after the places were held (a hold alone does not keep a session running).
    const [session] = await db.select({ status: s.sessions.status }).from(s.sessions).where(eq(s.sessions.id, hold.sessionId)).limit(1);
    if (!session || session.status !== "scheduled") {
      await releaseHold(db, hold.id);
      throw new BookingError("GONE", "Sorry, that time has just been cancelled. Please choose another time.");
    }
  }

  let q;
  try {
    q = quoteForService(null, { service, venue, lines: hold.lines, addOns: hold.addOns });
  } catch (e) {
    throw toBookingError(e);
  }

  const payInStore = Boolean(input.payInStore && service.payInStoreEnabled);
  const common = {
    hold,
    quote: q,
    venue,
    service,
    organisation,
    customer,
    birthdayChild: service.kind === "slot" ? (input.birthdayChild ?? null) : null,
    message: input.message ?? null,
    acceptedAt: now,
    termsVersion: organisation.termsVersion,
    waiverVersion: organisation.waiverVersion,
  };

  if (payInStore) {
    const { booking, previousCheckoutId } = await db.transaction(async (tx) => {
      // Re-read and lock the hold: a concurrent checkout on it waits here and then sees our booking.
      const locked = await lockActiveHold(tx, hold.id, now);
      const prev = await supersedePreviousBooking(tx, locked);
      const b = await createPendingBookingFromHold(tx, { ...common, hold: locked, paymentMethod: "pay_in_store" });
      return { booking: b, previousCheckoutId: prev };
    });
    if (previousCheckoutId) {
      await safely("expire previous checkout", async () => {
        const resolved = await getPaymentProvider(venue.slug);
        if (resolved) await resolved.provider.expireCheckout(previousCheckoutId);
      });
    }
    await safely("confirmation email", () => sendBookingEmail(db, { bookingId: booking.id, template: "confirmation", dedupe: true }));
    if (service.kind === "slot") {
      await safely("owner party alert", () => sendBookingEmail(db, { bookingId: booking.id, template: "owner_new_party", dedupe: true }));
    }
    await safely("calendar create", () => syncBookingToCalendar(db, booking.id, "create"));
    const urls = buildReturnUrls({ returnUrl: input.returnUrl, venueSlug: venue.slug, token: booking.token });
    return { bookingId: booking.id, reference: booking.reference, token: booking.token, confirmed: true, thanksUrl: urls.thanksUrl };
  }

  const resolved = await getPaymentProvider(venue.slug);
  if (!resolved) {
    await releaseHold(db, hold.id);
    throw new BookingError("UNAVAILABLE", "This venue cannot take payments online right now. Please call or message us to book.");
  }
  const provider = resolved.provider;

  const { booking, previousCheckoutId, lockedHold } = await db.transaction(async (tx) => {
    // Re-read and lock the hold: a concurrent checkout on it waits here and then
    // supersedes the booking this one creates, so only one pending booking survives.
    const locked = await lockActiveHold(tx, hold.id, now);
    const prev = await supersedePreviousBooking(tx, locked);
    const b = await createPendingBookingFromHold(tx, { ...common, hold: locked, paymentMethod: "online_card" });
    return { booking: b, previousCheckoutId: prev, lockedHold: locked };
  });
  if (previousCheckoutId) await safely("expire previous checkout", () => provider.expireCheckout(previousCheckoutId));

  const urls = buildReturnUrls({ returnUrl: input.returnUrl, venueSlug: venue.slug, token: booking.token });
  const lineItems: CheckoutLineItem[] = [
    ...q.lines.map((l) => ({ name: l.name, qty: l.qty, unitPence: l.unitPence })),
    ...q.addOns.map((a) => ({ name: a.name, qty: a.qty, unitPence: a.unitPence })),
  ].filter((li) => li.qty > 0 && li.unitPence > 0);

  let checkout;
  try {
    checkout = await provider.createCheckout({
      venueSlug: venue.slug,
      bookingId: booking.id,
      bookingReference: booking.reference,
      holdId: hold.id,
      customerEmail: customer.email,
      customerName: `${customer.firstName} ${customer.lastName}`.trim(),
      amountPence: q.totalPence,
      currency: organisation.currency,
      description: `${booking.reference}: ${describeBooking(service.name, booking.startsAt, tz)} at ${venue.name}`,
      lineItems,
      successUrl: urls.successUrl,
      cancelUrl: urls.cancelUrl,
      expiresAt: lockedHold.expiresAt,
      metadata: { bookingId: booking.id, bookingReference: booking.reference },
    });
  } catch (e) {
    console.error("[checkout] createCheckout failed:", e instanceof Error ? e.message : e);
    // The places stay held (the hold is detached from the cancelled booking) so "try again" works.
    await cancelPendingBooking(db, { bookingId: booking.id, reason: "abandoned", keepHold: true });
    throw new BookingError(
      "UNAVAILABLE",
      "We could not open the payment page. Your places are still held for a few minutes, so please try again.",
    );
  }

  // The payment page is recorded only if this booking still owns the hold: pressing
  // Pay again (or the hold running out) while the page was being created has already
  // cancelled this booking, and its page must not stay payable.
  const attached = await db.transaction(async (tx) => {
    // Lock order as in the expiry job and `supersedePreviousBooking`: the hold, then the booking.
    const [current] = await tx.select().from(s.holds).where(eq(s.holds.id, hold.id)).for("update");
    const [mine] = await tx.select({ status: s.bookings.status }).from(s.bookings).where(eq(s.bookings.id, booking.id)).for("update");
    if (!current || current.bookingId !== booking.id || mine?.status !== "pending") {
      return { ok: false as const, expired: !current || current.status !== "active" || current.expiresAt.getTime() <= now.getTime() };
    }
    await tx.insert(s.payments).values({
      bookingId: booking.id,
      venueId: venue.id,
      provider: checkout.provider,
      providerCheckoutId: checkout.checkoutId,
      amountPence: q.totalPence,
      currency: organisation.currency,
      status: "pending",
      method: "online_card",
    });
    await setHoldCheckout(tx, hold.id, checkout.checkoutId);
    if (checkout.provider === "demo" && isDemo()) {
      await saveDemoReturnUrls(tx, booking.id, { successUrl: urls.successUrl, cancelUrl: urls.cancelUrl });
    }
    return { ok: true as const, expired: false };
  });
  if (!attached.ok) {
    await safely("expire superseded checkout", () => provider.expireCheckout(checkout.checkoutId));
    if (attached.expired) {
      throw new HoldError("HOLD_EXPIRED", "Your places were held for a short time and that time has run out. Please choose a time again.");
    }
    throw new BookingError("STATE", "You pressed Pay again, so this payment page was closed. Please use the one that opened last.");
  }

  return { bookingId: booking.id, reference: booking.reference, checkoutUrl: checkout.url };
}

/**
 * The customer pressed Pay again with the same hold (came back from the payment
 * page, or double-submitted): the earlier pending booking is cancelled so its
 * places are not counted twice, and its checkout is returned to be expired.
 */
async function supersedePreviousBooking(tx: DbOrTx, hold: s.Hold): Promise<string | null> {
  // `hold` must be the row locked by `lockActiveHold` in this transaction.
  if (!hold.bookingId) return null;
  const [prev] = await tx
    .select()
    .from(s.bookings)
    .where(and(eq(s.bookings.id, hold.bookingId), eq(s.bookings.status, "pending")))
    .for("update");
  if (!prev) return null;
  await tx
    .update(s.bookings)
    .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "abandoned", updatedAt: new Date() })
    .where(eq(s.bookings.id, prev.id));
  await tx
    .update(s.payments)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and(eq(s.payments.bookingId, prev.id), eq(s.payments.status, "pending")));
  await audit(tx, {
    user: null,
    action: "booking.cancel_pending.superseded",
    entityType: "booking",
    entityId: prev.id,
    venueId: prev.venueId,
    before: { status: prev.status },
    after: { status: "cancelled", cancelReason: "abandoned" },
  });
  return hold.checkoutId ?? null;
}

async function safely(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[checkout] ${what} failed:`, e instanceof Error ? e.message : e);
  }
}

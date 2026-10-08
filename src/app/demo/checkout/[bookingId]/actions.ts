"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as s from "@/db/schema";
import { isDemo } from "@/lib/env";
import { isUuid } from "@/server/catalogue";
import { cancelPendingBooking, confirmBookingPaid } from "@/server/bookings";
import { getDemoReturnUrls } from "@/server/checkout";

/** Demo "Pay": runs the same confirmation code as the Stripe webhook, then goes to the success URL. */
export async function payDemoCheckout(bookingId: string): Promise<void> {
  if (!isDemo() || !isUuid(bookingId)) redirect("/book");
  const db = await getDb();
  const [booking] = await db.select().from(s.bookings).where(eq(s.bookings.id, bookingId)).limit(1);
  if (!booking) redirect("/book");
  const [org] = await db.select({ currency: s.organisations.currency }).from(s.organisations).limit(1);
  let target: string;
  try {
    await confirmBookingPaid(db, {
      bookingId,
      payment: { provider: "demo", providerCheckoutId: `demo_cs_${bookingId}`, amountPence: booking.totalPence, currency: org?.currency ?? "gbp" },
    });
    target = (await getDemoReturnUrls(db, bookingId, { remove: true })).successUrl;
  } catch (e) {
    console.error("[demo checkout] pay failed:", e);
    target = (await getDemoReturnUrls(db, bookingId)).cancelUrl;
  }
  redirect(target);
}

/** Demo "Decline": the payment failed; the booking is cancelled and the places are released. */
export async function declineDemoCheckout(bookingId: string): Promise<void> {
  if (!isDemo() || !isUuid(bookingId)) redirect("/book");
  const db = await getDb();
  await cancelPendingBooking(db, { bookingId, reason: "declined" });
  const { cancelUrl } = await getDemoReturnUrls(db, bookingId, { remove: true });
  redirect(cancelUrl);
}

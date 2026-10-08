import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as s from "@/db/schema";
import { isDemo } from "@/lib/env";
import { DEFAULT_TZ, fmtDayLong, fmtPence, fmtTime } from "@/core/time";
import { isUuid } from "@/server/catalogue";
import { getDemoReturnUrls } from "@/server/checkout";
import { declineDemoCheckout, payDemoCheckout } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Demo checkout", robots: { index: false } };

type Props = { params: Promise<{ bookingId: string }> };

export default async function DemoCheckoutPage({ params }: Props) {
  if (!isDemo()) notFound();
  const { bookingId } = await params;
  if (!isUuid(bookingId)) notFound();
  const db = await getDb();
  const [row] = await db
    .select({ booking: s.bookings, serviceName: s.services.name, venueName: s.venues.name, tz: s.organisations.timezone })
    .from(s.bookings)
    .innerJoin(s.services, eq(s.services.id, s.bookings.serviceId))
    .innerJoin(s.venues, eq(s.venues.id, s.bookings.venueId))
    .innerJoin(s.organisations, eq(s.organisations.id, s.venues.organisationId))
    .where(eq(s.bookings.id, bookingId))
    .limit(1);
  if (!row) notFound();
  const { booking } = row;
  const tz = row.tz || DEFAULT_TZ;
  const items = [
    ...booking.lines.map((l) => ({ key: `l-${l.optionId}`, name: l.name, qty: l.qty, total: l.totalPence })),
    ...booking.addOns.map((a) => ({ key: `a-${a.addOnId}`, name: a.name, qty: a.qty, total: a.totalPence })),
  ];
  const pending = booking.status === "pending";
  const urls = pending ? null : await getDemoReturnUrls(db, booking.id);
  const pay = payDemoCheckout.bind(null, booking.id);
  const decline = declineDemoCheckout.bind(null, booking.id);

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-950 [color-scheme:light]">
      <main className="mx-auto max-w-md px-4 py-10">
        <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-600">BayPook demo checkout</p>
        <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
          <h1 className="text-xl font-semibold">Pay for booking {booking.reference}</h1>
          <p className="mt-1 text-neutral-700">
            {row.serviceName} at {row.venueName}
            <br />
            {fmtDayLong(booking.startsAt, tz)}, {fmtTime(booking.startsAt, tz)} to {fmtTime(booking.endsAt, tz)}
          </p>
          <ul className="mt-4 divide-y divide-neutral-200 border-y border-neutral-200">
            {items.map((i) => (
              <li key={i.key} className="flex justify-between gap-4 py-2">
                <span>
                  {i.qty} × {i.name}
                </span>
                <span className="tabular-nums">{fmtPence(i.total)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 flex justify-between text-lg font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{fmtPence(booking.totalPence)}</span>
          </p>
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            This is a demo. No card is charged. Pay runs the same confirmation as a real payment.
          </p>

          {pending ? (
            <div className="mt-5 grid gap-3">
              <form action={pay}>
                <button type="submit" className="w-full rounded-xl bg-green-700 px-4 py-4 text-lg font-semibold text-white hover:bg-green-800 focus:outline-none focus-visible:ring-4 focus-visible:ring-green-300">
                  Pay {fmtPence(booking.totalPence)}
                </button>
              </form>
              <form action={decline}>
                <button type="submit" className="w-full rounded-xl border-2 border-neutral-300 bg-white px-4 py-4 text-lg font-semibold text-neutral-900 hover:bg-neutral-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-neutral-300">
                  Decline the payment
                </button>
              </form>
              <Link href="/book" className="text-center text-sm text-neutral-600 underline">
                Abandon (leave the hold to expire)
              </Link>
            </div>
          ) : (
            <div className="mt-5 grid gap-3">
              <p className="text-neutral-800">
                {booking.status === "confirmed"
                  ? "This booking is already paid and confirmed."
                  : "This booking is no longer waiting for payment (the hold ran out or the payment was declined)."}
              </p>
              {urls ? (
                <a href={booking.status === "confirmed" ? urls.successUrl : urls.cancelUrl} className="text-center font-semibold text-green-800 underline">
                  Continue
                </a>
              ) : null}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

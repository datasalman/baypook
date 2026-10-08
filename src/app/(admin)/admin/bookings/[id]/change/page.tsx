import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { fmtDayLong, fmtTime, localDate } from "@/core/time";
import { canAccessVenue } from "@/server/auth";
import { getBookingDetail } from "@/server/bookings";
import { getService } from "@/server/catalogue";
import { getAdminContext } from "@/server/venue-scope";
import { Banner, PageHeader } from "@/components/ui";
import { withFlash } from "@/components/ui/flash";
import { adminSessionChoices } from "../../_lib/availability";
import { editorCatalogue } from "../../_lib/catalogue";
import { customerName } from "../../_lib/labels";
import { ChangeCountsForm } from "./ChangeCountsForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Change places" };

export default async function ChangeCountsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAdminContext();
  const detail = await getBookingDetail(ctx.db, id);
  if (!detail || !canAccessVenue(ctx.user, detail.booking.venueId)) {
    redirect(withFlash("/admin/bookings", "We could not find that booking, or it belongs to another venue.", "error"));
  }
  const { booking: b, venue, customer } = detail;
  if (b.status !== "confirmed") redirect(withFlash(`/admin/bookings/${b.id}`, "Only a confirmed booking can be changed.", "error"));
  const service = await getService(ctx.db, b.serviceId, { includeArchived: true });
  if (!service) redirect(withFlash(`/admin/bookings/${b.id}`, "That service no longer exists.", "error"));

  const tz = ctx.org.timezone;
  const catalogue = editorCatalogue(service, venue);
  const activeOptionIds = new Set(catalogue.options.map((o) => o.id));
  const activeAddOnIds = new Set(catalogue.addOns.map((a) => a.id));
  const dropped = [
    ...b.lines.filter((l) => l.qty > 0 && !activeOptionIds.has(l.optionId)).map((l) => l.name),
    ...b.addOns.filter((a) => a.qty > 0 && !activeAddOnIds.has(a.addOnId)).map((a) => a.name),
  ];

  let placesLeft: number | null = null;
  if (service.kind === "session" && b.sessionId) {
    const list = await adminSessionChoices(ctx.db, { venue, service, date: localDate(b.startsAt, tz), tz, excludeBookingId: b.id });
    const mine = list.find((a) => a.sessionId === b.sessionId);
    placesLeft = mine ? mine.remaining : b.places;
  }

  return (
    <>
      <PageHeader
        back={{ href: `/admin/bookings/${b.id}`, label: b.reference }}
        title={service.kind === "slot" ? "Change children or extras" : "Change places"}
        subtitle={`${customerName(customer)} · ${service.name}, ${fmtDayLong(b.startsAt, tz)} at ${fmtTime(b.startsAt, tz)}`}
      />
      <p className="mb-3 text-sm text-muted">
        Prices are today&apos;s prices.
        {placesLeft !== null ? ` Up to ${placesLeft} ${placesLeft === 1 ? "place" : "places"} for this booking at this time.` : ""}
      </p>
      {dropped.length ? (
        <Banner className="mb-3">
          {dropped.join(", ")} {dropped.length === 1 ? "is" : "are"} no longer sold, so {dropped.length === 1 ? "it is" : "they are"} not shown. Choose
          from what is on sale now.
        </Banner>
      ) : null}
      <ChangeCountsForm
        bookingId={b.id}
        catalogue={catalogue}
        initialLines={sumByKey(b.lines.map((l) => [l.optionId, l.qty]))}
        initialAddOns={sumByKey(b.addOns.map((a) => [a.addOnId, a.qty]))}
        placesLeft={placesLeft}
        netPaidPence={b.paidPence - b.refundedPence}
      />
    </>
  );
}

/** One option can appear on several lines when places were sold at different prices; the form edits the total. */
function sumByKey(pairs: [string, number][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, q] of pairs) out[k] = (out[k] ?? 0) + q;
  return out;
}

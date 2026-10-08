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
import { ChangeCountsForm, type SoldItem } from "./ChangeCountsForm";

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
  // Archived items already on this booking stay in the editor (at the price paid).
  const catalogue = editorCatalogue(service, venue, {
    optionIds: b.lines.filter((l) => l.qty > 0).map((l) => l.optionId),
    addOnIds: b.addOns.filter((a) => a.qty > 0).map((a) => a.addOnId),
  });
  const archivedIds = [
    ...service.options.filter((o) => o.archivedAt).map((o) => o.id),
    ...service.addOns.filter((a) => a.archivedAt).map((a) => a.id),
  ];
  const optionIds = new Set(catalogue.options.map((o) => o.id));
  const addOnIds = new Set(catalogue.addOns.map((a) => a.id));
  // Items deleted from the catalogue altogether (not just archived) cannot be shown.
  const dropped = [
    ...b.lines.filter((l) => l.qty > 0 && !optionIds.has(l.optionId)).map((l) => l.name),
    ...b.addOns.filter((a) => a.qty > 0 && !addOnIds.has(a.addOnId)).map((a) => a.name),
  ];
  const sold = {
    options: groupSold(b.lines.map((l) => [l.optionId, { qty: l.qty, unitPence: l.unitPence, includedChildren: l.includedChildren ?? null }])),
    addOns: groupSold(b.addOns.map((a) => [a.addOnId, { qty: a.qty, unitPence: a.unitPence }])),
  };

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
        Places you have already paid for keep their price; added places are at today&apos;s price.
        {placesLeft !== null ? ` Up to ${placesLeft} ${placesLeft === 1 ? "place" : "places"} for this booking at this time.` : ""}
      </p>
      {dropped.length ? (
        <Banner className="mb-3">
          {dropped.join(", ")} {dropped.length === 1 ? "is" : "are"} no longer in the catalogue, so {dropped.length === 1 ? "it is" : "they are"} not
          shown. Choose from what is on sale now.
        </Banner>
      ) : null}
      <ChangeCountsForm
        bookingId={b.id}
        catalogue={catalogue}
        initialLines={sumByKey(b.lines.map((l) => [l.optionId, l.qty]))}
        initialAddOns={sumByKey(b.addOns.map((a) => [a.addOnId, a.qty]))}
        sold={sold}
        archivedIds={archivedIds}
        placesLeft={placesLeft}
        paidPence={b.paidPence}
        refundedPence={b.refundedPence}
      />
    </>
  );
}

/** The price tranches already on the booking, per option or extra id (zero quantities left out). */
function groupSold(pairs: [string, SoldItem][]): Record<string, SoldItem[]> {
  const out: Record<string, SoldItem[]> = {};
  for (const [k, item] of pairs) if (item.qty > 0) (out[k] ??= []).push(item);
  return out;
}

/** One option can appear on several lines when places were sold at different prices; the form edits the total. */
function sumByKey(pairs: [string, number][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, q] of pairs) out[k] = (out[k] ?? 0) + q;
  return out;
}
